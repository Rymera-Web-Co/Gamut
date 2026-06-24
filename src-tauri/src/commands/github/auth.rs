//! GitHub authentication: token storage (keychain / settings) and the OAuth
//! device flow, plus the connection-status commands. Split out of the github
//! module for navigability (#138).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::time::sleep;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::{api_base, del_setting, get_setting, http, set_setting, GhUser};

const SETTING_LOGIN: &str = "github_login";
const SETTING_TOKEN: &str = "github_token";
const KEYRING_SERVICE: &str = "com.rymera.gamut";
const KEYRING_USER: &str = "github-token";

// ---- Token storage ----
//
// Release builds store the token in the OS keychain (encrypted). Dev builds
// store it in the app's SQLite settings instead: an *unsigned* dev binary makes
// macOS prompt on every keychain access and "Always Allow" doesn't persist
// across rebuilds (it binds to the code signature). The non-secret login name
// always lives in settings so startup never touches the keychain.

/// Use the OS keychain for the token only in release builds.
fn use_keychain() -> bool {
    !cfg!(debug_assertions)
}

fn token_entry() -> AppResult<keyring::Entry> {
    Ok(keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)?)
}

fn read_token_store(state: &AppState) -> AppResult<Option<String>> {
    if use_keychain() {
        match token_entry()?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.into()),
        }
    } else {
        get_setting(state, SETTING_TOKEN)
    }
}

fn write_token_store(state: &AppState, token: &str) -> AppResult<()> {
    if use_keychain() {
        token_entry()?.set_password(token)?;
        Ok(())
    } else {
        set_setting(state, SETTING_TOKEN, token)
    }
}

fn delete_token_store(state: &AppState) -> AppResult<()> {
    if use_keychain() {
        match token_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.into()),
        }
    } else {
        del_setting(state, SETTING_TOKEN)
    }
}

/// Get the token, caching it in memory after the first DB read. Shared by the
/// REST and GraphQL command modules.
pub(super) fn require_token(state: &AppState) -> AppResult<String> {
    if let Some(t) = state
        .gh_token
        .lock()
        .map_err(|e| AppError::Other(format!("token lock poisoned: {e}")))?
        .clone()
    {
        return Ok(t);
    }
    let token = read_token_store(state)?.ok_or(AppError::NotSignedIn)?;
    cache_token(state, Some(token.clone()))?;
    Ok(token)
}

fn cache_token(state: &AppState, token: Option<String>) -> AppResult<()> {
    *state
        .gh_token
        .lock()
        .map_err(|e| AppError::Other(format!("token lock poisoned: {e}")))? = token;
    Ok(())
}

fn store_credentials(state: &AppState, token: &str, login: &str) -> AppResult<()> {
    write_token_store(state, token)?;
    set_setting(state, SETTING_LOGIN, login)?;
    cache_token(state, Some(token.to_string()))
}

/// OAuth App client ID for the device flow. The client ID is public (not a
/// secret), so it's safe to commit. This is the "Gamut" OAuth App owned by the
/// Rymera-Web-Co org. Override at runtime with GAMUT_GITHUB_CLIENT_ID.
const DEFAULT_CLIENT_ID: &str = "Ov23lizeswh97Fq6GTC3";

fn client_id() -> Option<String> {
    if let Ok(v) = std::env::var("GAMUT_GITHUB_CLIENT_ID") {
        if !v.is_empty() {
            return Some(v);
        }
    }
    Some(DEFAULT_CLIENT_ID.to_string())
}

/// Validate a token against /user, returning the login.
async fn validate_token(client: &reqwest::Client, api: &str, token: &str) -> AppResult<String> {
    let resp = client
        .get(format!("{api}/user"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "token rejected by GitHub ({})",
            resp.status()
        )));
    }
    let user: GhUser = resp.json().await?;
    Ok(user.login)
}

#[derive(Serialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub login: Option<String>,
}

#[derive(Serialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: Option<String>,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Deserialize)]
struct DeviceCodeResp {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    interval: u64,
    expires_in: u64,
}

#[derive(Deserialize)]
struct TokenResp {
    access_token: Option<String>,
    error: Option<String>,
}

/// Whether OAuth (device flow) is available — i.e. a client ID is configured.
#[tauri::command]
pub fn github_oauth_available() -> bool {
    client_id().is_some()
}

/// Begin the GitHub OAuth device flow: returns a user code + verification URL
/// to show the user. Follow with `github_device_poll`.
#[tauri::command]
pub async fn github_device_start() -> AppResult<DeviceCode> {
    let cid = client_id().ok_or_else(|| {
        AppError::Other(
            "GitHub OAuth is not configured (set GAMUT_GITHUB_CLIENT_ID). Use a token instead."
                .into(),
        )
    })?;
    let client = http()?;
    let resp = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", cid.as_str()), ("scope", "repo read:org")])
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "GitHub device-code request failed ({})",
            resp.status()
        )));
    }
    let d: DeviceCodeResp = resp.json().await?;
    Ok(DeviceCode {
        device_code: d.device_code,
        user_code: d.user_code,
        verification_uri: d.verification_uri,
        verification_uri_complete: d.verification_uri_complete,
        interval: d.interval,
        expires_in: d.expires_in,
    })
}

/// Poll for the device-flow token until the user authorizes (or it expires).
/// On success the token is stored in the keychain.
#[tauri::command]
pub async fn github_device_poll(
    state: State<'_, AppState>,
    device_code: String,
    interval: u64,
    expires_in: u64,
) -> AppResult<AuthStatus> {
    let cid =
        client_id().ok_or_else(|| AppError::Other("GitHub OAuth is not configured".into()))?;
    let client = http()?;
    let api = api_base(&state);
    let mut wait = interval.max(5);
    let mut elapsed = 0u64;

    loop {
        sleep(Duration::from_secs(wait)).await;
        elapsed += wait;
        if elapsed > expires_in {
            return Err(AppError::Other(
                "authorization timed out — please try again".into(),
            ));
        }

        let resp = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", cid.as_str()),
                ("device_code", device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?;
        let body: TokenResp = resp.json().await?;

        if let Some(token) = body.access_token {
            let login = validate_token(&client, &api, &token).await?;
            store_credentials(&state, &token, &login)?;
            return Ok(AuthStatus {
                logged_in: true,
                login: Some(login),
            });
        }

        match body.error.as_deref() {
            Some("authorization_pending") => continue,
            Some("slow_down") => {
                wait += 5;
                continue;
            }
            Some("expired_token") => {
                return Err(AppError::Other(
                    "the code expired — please try again".into(),
                ))
            }
            Some("access_denied") => {
                return Err(AppError::Other("authorization was denied".into()))
            }
            Some(other) => return Err(AppError::Other(format!("GitHub: {other}"))),
            None => continue,
        }
    }
}

/// Validate and store a GitHub personal-access token in the OS keychain.
#[tauri::command]
pub async fn github_set_token(state: State<'_, AppState>, token: String) -> AppResult<AuthStatus> {
    let client = http()?;
    let api = api_base(&state);
    let login = validate_token(&client, &api, &token).await?;
    store_credentials(&state, &token, &login)?;
    Ok(AuthStatus {
        logged_in: true,
        login: Some(login),
    })
}

/// Connected status — read from the stored (non-secret) login, so this does NOT
/// touch the keychain (no prompt on startup).
#[tauri::command]
pub fn github_auth_status(state: State<AppState>) -> AppResult<AuthStatus> {
    let login = get_setting(&state, SETTING_LOGIN)?;
    Ok(AuthStatus {
        logged_in: login.is_some(),
        login,
    })
}

#[tauri::command]
pub fn github_logout(state: State<AppState>) -> AppResult<()> {
    delete_token_store(&state)?;
    del_setting(&state, SETTING_LOGIN)?;
    cache_token(&state, None)
}

/// Verify the stored token reaches the **configured** API host and refresh the
/// cached login. Used by Settings after changing the API base URL (GHES) so the
/// user gets an immediate pass/fail against the new endpoint. Errors when not
/// signed in or the host/token is wrong.
#[tauri::command]
pub async fn github_check(state: State<'_, AppState>) -> AppResult<AuthStatus> {
    let token = require_token(&state)?;
    let api = api_base(&state);
    let client = http()?;
    let login = validate_token(&client, &api, &token).await?;
    set_setting(&state, SETTING_LOGIN, &login)?;
    Ok(AuthStatus {
        logged_in: true,
        login: Some(login),
    })
}
