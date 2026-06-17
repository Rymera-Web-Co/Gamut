use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::time::sleep;

use crate::commands::history::open_repo;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const API: &str = "https://api.github.com";
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

fn http() -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder().user_agent("gamut").build()?)
}

fn get_setting(state: &AppState, key: &str) -> AppResult<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .ok())
}

fn set_setting(state: &AppState, key: &str, value: &str) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

fn del_setting(state: &AppState, key: &str) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    Ok(())
}

/// Get the token, caching it in memory after the first DB read.
fn require_token(state: &AppState) -> AppResult<String> {
    if let Some(t) = state
        .gh_token
        .lock()
        .map_err(|e| AppError::Other(format!("token lock poisoned: {e}")))?
        .clone()
    {
        return Ok(t);
    }
    let token = read_token_store(state)?
        .ok_or_else(|| AppError::Other("not signed in to GitHub".into()))?;
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

/// Build a descriptive error from a failed GitHub response: include GitHub's
/// own `message`, and surface the SSO header when org SAML authorization is
/// required (GitHub returns 403 with `x-github-sso` in that case).
async fn api_error(context: &str, resp: reqwest::Response) -> AppError {
    let status = resp.status();
    let sso = resp
        .headers()
        .get("x-github-sso")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| status.to_string());

    let mut msg = format!("GitHub {status} {context}: {detail}");
    if let Some(sso) = sso {
        msg.push_str(&format!(
            " — your token needs SAML SSO authorization for this org ({sso})"
        ));
    }
    AppError::Other(msg)
}

/// Validate a token against /user, returning the login.
async fn validate_token(client: &reqwest::Client, token: &str) -> AppResult<String> {
    let resp = client
        .get(format!("{API}/user"))
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

// ---- Remote parsing ----

/// Whether `host` is GitHub, including custom SSH host aliases that resolve to
/// `github.com` (a common multi-identity setup, e.g. `rymera.github.com` or
/// `github.com-work` in `~/.ssh/config`). Non-GitHub hosts like `gitlab.com`
/// are rejected.
fn is_github_host(host: &str) -> bool {
    host == "github.com" || host.ends_with(".github.com") || host.starts_with("github.com-")
}

/// The `host` part of an `https://host/...` URL, lowercased, with any userinfo
/// and `:port` stripped. Returns `None` for non-`https` URLs.
fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?; // drop optional user@
    let host = host.split(':').next()?; // drop optional :port
    if host.is_empty() {
        None
    } else {
        Some(host.to_ascii_lowercase())
    }
}

/// Whether `host` serves GitHub-hosted attachment/asset images. These are the
/// URLs embedded in issue/PR bodies (`github.com/user-attachments/assets/…`,
/// `*-user-images.githubusercontent.com`, `camo.githubusercontent.com`, …);
/// the authenticated ones 403 in a cookieless webview, so we proxy them with
/// the user's token. Restricting to GitHub hosts keeps this from being an open
/// proxy that would leak the token to arbitrary servers.
fn is_github_asset_host(host: &str) -> bool {
    host == "github.com"
        || host.ends_with(".github.com")
        || host == "githubusercontent.com"
        || host.ends_with(".githubusercontent.com")
}

/// Split a git remote URL into its `(host, owner, repo)` components, supporting
/// the generic forms rather than keying on a literal `github.com` host:
///   https://host/owner/repo[.git]
///   ssh://[user@]host[:port]/owner/repo[.git]
///   git://host/owner/repo[.git]
///   [user@]host:owner/repo[.git]            (scp-like)
fn split_remote(url: &str) -> Option<(String, String, String)> {
    let u = url.trim();

    let (host, path) = if let Some(rest) = u
        .strip_prefix("https://")
        .or_else(|| u.strip_prefix("http://"))
        .or_else(|| u.strip_prefix("ssh://"))
        .or_else(|| u.strip_prefix("git://"))
    {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?; // drop optional user@
        let host = host.split(':').next()?; // drop optional :port
        (host, path)
    } else {
        // scp-like: [user@]host:owner/repo
        let (authority, path) = u.split_once(':')?;
        let host = authority.rsplit('@').next()?; // drop optional user@
        (host, path)
    };

    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.trim_matches('/').splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches('/').to_string();
    if host.is_empty() || owner.is_empty() || repo.is_empty() {
        None
    } else {
        Some((host.to_string(), owner, repo))
    }
}

fn parse_owner_repo(url: &str) -> Option<(String, String)> {
    let (host, owner, repo) = split_remote(url)?;
    is_github_host(&host).then_some((owner, repo))
}

/// Resolve an SSH host alias to its effective `HostName` via `ssh -G`, returning
/// true if that resolves to a GitHub host. This handles arbitrarily-named
/// aliases (e.g. `Host mygit` → `HostName github.com`) that the `is_github_host`
/// name heuristic can't recognise. Returns false if `ssh` is unavailable or the
/// alias doesn't resolve to GitHub — callers fall back to the name heuristic.
fn ssh_alias_resolves_to_github(host: &str) -> bool {
    let Ok(output) = std::process::Command::new("ssh")
        .arg("-G")
        .arg(host)
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout).lines().any(|line| {
        let mut it = line.split_whitespace();
        // `ssh -G` lowercases keys, e.g. `hostname github.com`.
        matches!(it.next(), Some("hostname")) && it.next().is_some_and(is_github_host)
    })
}

/// Resolve the GitHub owner/repo from the repo's `origin` remote.
fn owner_repo(state: &State<AppState>, repo_id: i64) -> AppResult<(String, String)> {
    let repo = open_repo(state, repo_id)?;
    let remote = repo
        .find_remote("origin")
        .map_err(|_| AppError::Other("repository has no 'origin' remote".into()))?;
    let url = remote
        .url()
        .ok_or_else(|| AppError::Other("origin remote has no URL".into()))?;
    let not_github = || AppError::Other(format!("origin is not a GitHub remote: {url}"));
    // Fast path: host is obviously GitHub by name.
    if let Some(owner_repo) = parse_owner_repo(url) {
        return Ok(owner_repo);
    }
    // Otherwise the host may be a custom SSH alias (e.g. `Host mygit` →
    // `HostName github.com`); resolve it via `ssh -G` before giving up.
    let (host, owner, repo) = split_remote(url).ok_or_else(not_github)?;
    if ssh_alias_resolves_to_github(&host) {
        Ok((owner, repo))
    } else {
        Err(not_github())
    }
}

/// Parse a GitHub **pull request** web URL into `(owner, repo, number)`.
/// Accepts the canonical `https://github.com/<owner>/<repo>/pull/<n>` form plus
/// any trailing path/query/fragment (`/files`, `#discussion_r…`). Returns `None`
/// for non-GitHub hosts, non-`https` URLs, or any non-PR path (issues, commits…).
fn parse_pr_url(url: &str) -> Option<(String, String, i64)> {
    let host = https_host(url)?;
    if !is_github_host(&host) {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    let path = rest.split_once('/')?.1;
    // Strip query/fragment, then take the leading path segments.
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next()? != "pull" {
        return None;
    }
    let number: i64 = parts.next()?.parse().ok()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string(), number))
}

/// A tracked PR resolved from a web URL: which app repo it belongs to and its
/// number, for navigating to the in-app Pull Requests tab.
#[derive(Serialize)]
pub struct PrRef {
    pub repo_id: i64,
    pub number: i64,
}

/// Map a GitHub PR web URL to a tracked repo, for the integrated terminal's
/// clickable links. Returns `Some` only when the URL is a PR URL **and** its
/// `<owner>/<repo>` matches a registered repo's `origin` remote (case-insensitive
/// — GitHub slugs aren't case-sensitive). Returns `None` otherwise, so the caller
/// falls back to opening the URL in the external browser.
#[tauri::command]
pub fn github_resolve_pr_url(state: State<AppState>, url: String) -> AppResult<Option<PrRef>> {
    let Some((owner, repo, number)) = parse_pr_url(&url) else {
        return Ok(None);
    };
    let ids: Vec<i64> = {
        let conn = state
            .db
            .lock()
            .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare("SELECT id FROM repos")?;
        let ids = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids
    };
    for id in ids {
        // A repo with no/non-GitHub origin simply doesn't match; skip it.
        if let Ok((o, r)) = owner_repo(&state, id) {
            if o.eq_ignore_ascii_case(&owner) && r.eq_ignore_ascii_case(&repo) {
                return Ok(Some(PrRef {
                    repo_id: id,
                    number,
                }));
            }
        }
    }
    Ok(None)
}

// ---- Serializable types ----

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

/// Whether OAuth (device flow) is available — i.e. a client ID is configured.
#[tauri::command]
pub fn github_oauth_available() -> bool {
    client_id().is_some()
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
            let login = validate_token(&client, &token).await?;
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

#[derive(Serialize)]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub state: String,
    pub draft: bool,
    pub base_ref: String,
    pub head_ref: String,
    pub head_sha: String,
    pub url: String,
    pub updated_at: String,
    pub author_avatar: Option<String>,
    /// Logins with a currently-pending review request on this PR. GitHub drops a
    /// reviewer from this list once they submit a review and re-adds them when a
    /// re-review is requested, so it matches "needs review from" exactly — no
    /// per-PR fetch needed to filter the list.
    pub requested_reviewers: Vec<String>,
}

#[derive(Serialize)]
pub struct PrComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub kind: String, // "comment" | "review" | "review_comment"
    pub state: Option<String>,
    pub author_avatar: Option<String>,
    // Set for inline review comments ("review_comment").
    pub path: Option<String>,
    pub line: Option<u64>,
    pub diff_hunk: Option<String>,
    pub html_url: Option<String>,
}

#[derive(Serialize)]
pub struct PrThread {
    pub title: String,
    pub author: String,
    pub state: String, // "open" | "closed" | "merged"
    pub body: String,
    pub created_at: String,
    pub author_avatar: Option<String>,
    pub comments: Vec<PrComment>,
}

// ---- GitHub API response shapes ----

#[derive(Deserialize)]
struct GhUser {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct GhRef {
    #[serde(rename = "ref")]
    ref_name: String,
    sha: String,
}

#[derive(Deserialize)]
struct GhPull {
    number: u64,
    title: String,
    draft: bool,
    state: String,
    html_url: String,
    user: GhUser,
    head: GhRef,
    base: GhRef,
    updated_at: String,
    #[serde(default)]
    requested_reviewers: Vec<GhUser>,
}

#[derive(Deserialize)]
struct GhPullFull {
    title: String,
    body: Option<String>,
    state: String,
    merged_at: Option<String>,
    created_at: String,
    user: GhUser,
}

#[derive(Deserialize)]
struct GhIssueComment {
    id: u64,
    user: GhUser,
    body: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct GhReview {
    id: u64,
    user: GhUser,
    body: Option<String>,
    state: String,
    submitted_at: Option<String>,
}

// ---- Commands ----

/// Validate and store a GitHub personal-access token in the OS keychain.
#[tauri::command]
pub async fn github_set_token(state: State<'_, AppState>, token: String) -> AppResult<AuthStatus> {
    let client = http()?;
    let login = validate_token(&client, &token).await?;
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

/// List open pull requests for the repo's GitHub origin.
#[tauri::command]
pub async fn github_list_prs(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<PrSummary>> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let resp = client
        .get(format!("{API}/repos/{owner}/{repo}/pulls"))
        .query(&[("state", "open"), ("per_page", "50")])
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(api_error("listing pull requests", resp).await);
    }
    let pulls: Vec<GhPull> = resp.json().await?;
    Ok(pulls
        .into_iter()
        .map(|p| PrSummary {
            number: p.number,
            title: p.title,
            author: p.user.login,
            state: p.state,
            draft: p.draft,
            base_ref: p.base.ref_name,
            head_ref: p.head.ref_name,
            head_sha: p.head.sha,
            url: p.html_url,
            updated_at: p.updated_at,
            author_avatar: p.user.avatar_url,
            requested_reviewers: p.requested_reviewers.into_iter().map(|u| u.login).collect(),
        })
        .collect())
}

/// The unified diff for a pull request.
#[tauri::command]
pub async fn github_pr_diff(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
) -> AppResult<String> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let resp = client
        .get(format!("{API}/repos/{owner}/{repo}/pulls/{number}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github.diff")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("fetching the PR diff", resp).await);
    }
    Ok(resp.text().await?)
}

/// Cap on a proxied image's size. GitHub rejects attachment uploads over 10 MB
/// for images, so this is comfortably above any legitimate inline image while
/// bounding the base64 payload we hold in memory and hand to the webview.
const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;

/// Fetch a GitHub-hosted attachment image with the user's token and return it
/// as a `data:` URL the webview can render directly.
///
/// Images embedded in issue/PR bodies often point at authenticated GitHub
/// hosts (`github.com/user-attachments/assets/…`,
/// `private-user-images.githubusercontent.com`). github.com serves them via a
/// signed redirect that a logged-in browser follows with its session cookies;
/// the Tauri webview has none, so those requests 403/404 and the image breaks.
/// Fetching here attaches the token for the initial GitHub request — reqwest
/// drops the `Authorization` header on the cross-host redirect to the signed
/// blob URL, so the token never leaves GitHub.
#[tauri::command]
pub async fn github_fetch_image(state: State<'_, AppState>, url: String) -> AppResult<String> {
    let host = https_host(&url)
        .ok_or_else(|| AppError::Other("only https image URLs can be proxied".into()))?;
    if !is_github_asset_host(&host) {
        return Err(AppError::Other(format!(
            "refusing to proxy non-GitHub image host: {host}"
        )));
    }

    let token = require_token(&state)?;
    let client = http()?;
    let resp = client
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "image/*")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("fetching an embedded image", resp).await);
    }

    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        .filter(|m| m.starts_with("image/"))
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(AppError::Other(format!(
            "embedded image is too large to display ({} MB)",
            bytes.len() / (1024 * 1024)
        )));
    }

    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

/// The conversation thread for a pull request: description + issue comments +
/// reviews, merged and sorted chronologically.
#[tauri::command]
pub async fn github_pr_thread(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
) -> AppResult<PrThread> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let base = format!("{API}/repos/{owner}/{repo}");

    let pr_resp = client
        .get(format!("{base}/pulls/{number}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !pr_resp.status().is_success() {
        return Err(api_error("loading the pull request", pr_resp).await);
    }
    let pr: GhPullFull = pr_resp.json().await?;

    let issue_comments: Vec<GhIssueComment> = {
        let resp = client
            .get(format!("{base}/issues/{number}/comments"))
            .query(&[("per_page", "100")])
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if resp.status().is_success() {
            resp.json().await?
        } else {
            Vec::new()
        }
    };

    let reviews: Vec<GhReview> = {
        let resp = client
            .get(format!("{base}/pulls/{number}/reviews"))
            .query(&[("per_page", "100")])
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if resp.status().is_success() {
            resp.json().await?
        } else {
            Vec::new()
        }
    };

    // Inline review comments are grouped into threads separately (see
    // github_review_threads), so they're not added to this flat timeline.
    let mut comments: Vec<PrComment> = Vec::new();
    for c in issue_comments {
        comments.push(PrComment {
            id: c.id,
            author: c.user.login,
            body: c.body.unwrap_or_default(),
            created_at: c.created_at,
            kind: "comment".to_string(),
            state: None,
            author_avatar: c.user.avatar_url,
            path: None,
            line: None,
            diff_hunk: None,
            html_url: None,
        });
    }
    for r in reviews {
        let body = r.body.unwrap_or_default();
        // Skip empty drive-by "commented" reviews (just inline comments).
        if body.is_empty() && r.state == "COMMENTED" {
            continue;
        }
        comments.push(PrComment {
            id: r.id,
            author: r.user.login,
            body,
            created_at: r.submitted_at.unwrap_or_default(),
            kind: "review".to_string(),
            state: Some(r.state),
            author_avatar: r.user.avatar_url,
            path: None,
            line: None,
            diff_hunk: None,
            html_url: None,
        });
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let state = if pr.merged_at.is_some() {
        "merged".to_string()
    } else {
        pr.state
    };

    Ok(PrThread {
        title: pr.title,
        author: pr.user.login,
        state,
        body: pr.body.unwrap_or_default(),
        created_at: pr.created_at,
        author_avatar: pr.user.avatar_url,
        comments,
    })
}

/// A non-comment event in a PR's timeline (commits, ready-for-review, review
/// requests, cross-references, labels, …). Comments and reviews are rendered
/// from `github_pr_thread`, so they're omitted here. Follows the flat
/// `kind` + optional-fields style of `PrComment`.
#[derive(Serialize)]
pub struct TimelineEvent {
    pub kind: String,
    pub created_at: String,
    pub actor: Option<String>,
    pub actor_avatar: Option<String>,
    // committed
    pub sha: Option<String>,
    pub short_sha: Option<String>,
    pub message: Option<String>,
    // review_requested / assigned — the reviewer/assignee (or team) login
    pub subject: Option<String>,
    // labeled / unlabeled
    pub label: Option<String>,
    pub label_color: Option<String>,
    // renamed
    pub rename_from: Option<String>,
    pub rename_to: Option<String>,
    // cross-referenced — the issue/PR that mentioned this one
    pub ref_number: Option<u64>,
    pub ref_title: Option<String>,
    pub ref_url: Option<String>,
    pub ref_is_pull: Option<bool>,
    // true for labeled/assigned/review_requested, false for the removals
    pub added: Option<bool>,
}

impl TimelineEvent {
    fn new(kind: &str, created_at: String) -> Self {
        TimelineEvent {
            kind: kind.to_string(),
            created_at,
            actor: None,
            actor_avatar: None,
            sha: None,
            short_sha: None,
            message: None,
            subject: None,
            label: None,
            label_color: None,
            rename_from: None,
            rename_to: None,
            ref_number: None,
            ref_title: None,
            ref_url: None,
            ref_is_pull: None,
            added: None,
        }
    }
}

fn str_at(v: &serde_json::Value, ptr: &str) -> Option<String> {
    v.pointer(ptr)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

/// The PR's event timeline (excluding comments/reviews): commits, review
/// requests, ready-for-review, cross-references, labels, etc. Used to enrich
/// the conversation view the way GitHub's web timeline does.
#[tauri::command]
pub async fn github_pr_timeline(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
) -> AppResult<Vec<TimelineEvent>> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let url = format!("{API}/repos/{owner}/{repo}/issues/{number}/timeline");

    // Walk pages until a short page (cap at 5 pages / 500 events — plenty).
    let mut raw: Vec<serde_json::Value> = Vec::new();
    for page in 1..=5u32 {
        let resp = client
            .get(&url)
            .query(&[("per_page", "100".to_string()), ("page", page.to_string())])
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if !resp.status().is_success() {
            if page == 1 {
                return Err(api_error("loading the PR timeline", resp).await);
            }
            break;
        }
        let batch: Vec<serde_json::Value> = resp.json().await?;
        let full = batch.len() == 100;
        raw.extend(batch);
        if !full {
            break;
        }
    }

    let actor = |e: &serde_json::Value| str_at(e, "/actor/login");
    let actor_avatar = |e: &serde_json::Value| str_at(e, "/actor/avatar_url");
    let at = |e: &serde_json::Value| str_at(e, "/created_at").unwrap_or_default();

    let mut out: Vec<TimelineEvent> = Vec::new();
    for e in &raw {
        let kind = e.get("event").and_then(|v| v.as_str()).unwrap_or("");
        match kind {
            "committed" => {
                let sha = str_at(e, "/sha").unwrap_or_default();
                let mut ev = TimelineEvent::new(
                    "committed",
                    str_at(e, "/committer/date")
                        .or_else(|| str_at(e, "/author/date"))
                        .unwrap_or_default(),
                );
                ev.short_sha = Some(sha.chars().take(7).collect());
                ev.sha = Some(sha);
                // Show only the commit subject (first line).
                ev.message =
                    str_at(e, "/message").map(|m| m.lines().next().unwrap_or("").to_string());
                ev.actor = str_at(e, "/author/name");
                out.push(ev);
            }
            "ready_for_review"
            | "convert_to_draft"
            | "closed"
            | "reopened"
            | "merged"
            | "head_ref_force_pushed"
            | "head_ref_deleted" => {
                let mut ev = TimelineEvent::new(kind, at(e));
                ev.actor = actor(e);
                ev.actor_avatar = actor_avatar(e);
                if kind == "merged" {
                    let cid = str_at(e, "/commit_id").unwrap_or_default();
                    ev.short_sha = Some(cid.chars().take(7).collect());
                    ev.sha = Some(cid);
                }
                out.push(ev);
            }
            "review_requested" | "review_request_removed" => {
                let mut ev = TimelineEvent::new("review_requested", at(e));
                ev.actor = actor(e);
                ev.actor_avatar = actor_avatar(e);
                ev.subject = str_at(e, "/requested_reviewer/login")
                    .or_else(|| str_at(e, "/requested_team/name"));
                ev.added = Some(kind == "review_requested");
                out.push(ev);
            }
            "labeled" | "unlabeled" => {
                let mut ev = TimelineEvent::new("labeled", at(e));
                ev.actor = actor(e);
                ev.actor_avatar = actor_avatar(e);
                ev.label = str_at(e, "/label/name");
                ev.label_color = str_at(e, "/label/color");
                ev.added = Some(kind == "labeled");
                out.push(ev);
            }
            "assigned" | "unassigned" => {
                let mut ev = TimelineEvent::new("assigned", at(e));
                ev.actor = actor(e);
                ev.actor_avatar = actor_avatar(e);
                ev.subject = str_at(e, "/assignee/login");
                ev.added = Some(kind == "assigned");
                out.push(ev);
            }
            "renamed" => {
                let mut ev = TimelineEvent::new("renamed", at(e));
                ev.actor = actor(e);
                ev.actor_avatar = actor_avatar(e);
                ev.rename_from = str_at(e, "/rename/from");
                ev.rename_to = str_at(e, "/rename/to");
                out.push(ev);
            }
            "cross-referenced" => {
                let mut ev = TimelineEvent::new("cross_referenced", at(e));
                ev.actor = str_at(e, "/actor/login");
                ev.actor_avatar = str_at(e, "/actor/avatar_url");
                ev.ref_number = e.pointer("/source/issue/number").and_then(|v| v.as_u64());
                ev.ref_title = str_at(e, "/source/issue/title");
                ev.ref_url = str_at(e, "/source/issue/html_url");
                ev.ref_is_pull = Some(e.pointer("/source/issue/pull_request").is_some());
                out.push(ev);
            }
            // Comments and reviews come from github_pr_thread; everything else
            // (subscribed, mentioned, …) is noise we drop.
            _ => {}
        }
    }

    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(out)
}

/// An inline review comment anchored to a line (or line range) of the diff.
#[derive(Deserialize)]
pub struct DraftComment {
    pub path: String,
    pub line: u64,
    pub side: String, // "LEFT" | "RIGHT"
    pub start_line: Option<u64>,
    pub start_side: Option<String>,
    pub body: String,
}

fn comment_json(c: &DraftComment) -> serde_json::Value {
    let mut m = serde_json::Map::new();
    m.insert("path".into(), serde_json::json!(c.path));
    m.insert("line".into(), serde_json::json!(c.line));
    m.insert("side".into(), serde_json::json!(c.side));
    m.insert("body".into(), serde_json::json!(c.body));
    if let Some(sl) = c.start_line {
        m.insert("start_line".into(), serde_json::json!(sl));
    }
    if let Some(ss) = &c.start_side {
        m.insert("start_side".into(), serde_json::json!(ss));
    }
    serde_json::Value::Object(m)
}

/// Submit a review on a pull request. `event` is APPROVE | REQUEST_CHANGES |
/// COMMENT. Any `comments` are submitted as inline review comments in the same
/// call (the pending-draft batch), anchored to `commit_id` when provided.
#[tauri::command]
pub async fn github_submit_review(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    event: String,
    body: String,
    commit_id: Option<String>,
    comments: Option<Vec<DraftComment>>,
) -> AppResult<()> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;

    let mut payload = serde_json::Map::new();
    payload.insert("event".into(), serde_json::json!(event));
    payload.insert("body".into(), serde_json::json!(body));
    if let Some(cid) = commit_id {
        payload.insert("commit_id".into(), serde_json::json!(cid));
    }
    if let Some(comments) = comments {
        if !comments.is_empty() {
            let arr: Vec<_> = comments.iter().map(comment_json).collect();
            payload.insert("comments".into(), serde_json::json!(arr));
        }
    }

    let resp = client
        .post(format!("{API}/repos/{owner}/{repo}/pulls/{number}/reviews"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::Value::Object(payload))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("submitting the review", resp).await);
    }
    Ok(())
}

/// Post a single inline review comment immediately (the "Comment" action),
/// anchored to a line/range of `commit_id`'s diff.
#[tauri::command]
pub async fn github_pr_comment(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    commit_id: String,
    comment: DraftComment,
) -> AppResult<()> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;

    let mut payload = comment_json(&comment);
    if let serde_json::Value::Object(ref mut m) = payload {
        m.insert("commit_id".into(), serde_json::json!(commit_id));
    }

    let resp = client
        .post(format!(
            "{API}/repos/{owner}/{repo}/pulls/{number}/comments"
        ))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&payload)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("posting the comment", resp).await);
    }
    Ok(())
}

/// Replace the body of the PR description, an issue comment, or a review.
/// Used to persist task-list checkbox toggles. `target` is "pr" | "comment" |
/// "review"; `id` is the comment/review id (ignored for "pr").
#[tauri::command]
pub async fn github_update_body(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    target: String,
    id: Option<u64>,
    body: String,
) -> AppResult<()> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let base = format!("{API}/repos/{owner}/{repo}");

    let req = match target.as_str() {
        "pr" => client.patch(format!("{base}/pulls/{number}")),
        "comment" => {
            let id = id.ok_or_else(|| AppError::Other("comment id required".into()))?;
            client.patch(format!("{base}/issues/comments/{id}"))
        }
        "review" => {
            let id = id.ok_or_else(|| AppError::Other("review id required".into()))?;
            client.put(format!("{base}/pulls/{number}/reviews/{id}"))
        }
        "review_comment" => {
            let id = id.ok_or_else(|| AppError::Other("comment id required".into()))?;
            client.patch(format!("{base}/pulls/comments/{id}"))
        }
        other => return Err(AppError::Other(format!("unknown update target: {other}"))),
    };

    let resp = req
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("updating the content", resp).await);
    }
    Ok(())
}

/// Logins that can be @-mentioned in the repo — its assignable users (the
/// collaborators GitHub allows on issues/PRs). Available with read access.
#[tauri::command]
pub async fn github_mentionables(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<String>> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let resp = client
        .get(format!("{API}/repos/{owner}/{repo}/assignees"))
        .query(&[("per_page", "100")])
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("listing mentionable users", resp).await);
    }
    let users: Vec<GhUser> = resp.json().await?;
    Ok(users.into_iter().map(|u| u.login).collect())
}

// ---- Review threads (grouped inline comments, via GraphQL) ----

#[derive(Serialize)]
pub struct ThreadComment {
    pub id: Option<u64>, // databaseId (for replies/edits)
    pub author: String,
    pub author_avatar: Option<String>,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct ReviewThread {
    pub id: String, // GraphQL node id (for resolve/unresolve)
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub diff_hunk: Option<String>,
    // The review this thread was submitted with, so it can be grouped under it.
    pub review_id: Option<u64>,
    pub comments: Vec<ThreadComment>,
}

const GRAPHQL: &str = "https://api.github.com/graphql";

const THREADS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{
          id isResolved isOutdated path line originalLine
          comments(first:100){
            nodes{ databaseId body createdAt url diffHunk pullRequestReview{ databaseId } author{ login avatarUrl } }
          }
        }
      }
    }
  }
}"#;

#[derive(Deserialize)]
struct GqlResp<T> {
    data: Option<T>,
    errors: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct GqlThreadsData {
    repository: Option<GqlRepo>,
}
#[derive(Deserialize)]
struct GqlRepo {
    #[serde(rename = "pullRequest")]
    pull_request: Option<GqlPr>,
}
#[derive(Deserialize)]
struct GqlPr {
    #[serde(rename = "reviewThreads")]
    review_threads: GqlConn<GqlThread>,
}
#[derive(Deserialize)]
struct GqlConn<T> {
    nodes: Vec<T>,
}
#[derive(Deserialize)]
struct GqlThread {
    id: String,
    #[serde(rename = "isResolved")]
    is_resolved: bool,
    #[serde(rename = "isOutdated")]
    is_outdated: bool,
    path: Option<String>,
    line: Option<u64>,
    #[serde(rename = "originalLine")]
    original_line: Option<u64>,
    comments: GqlConn<GqlComment>,
}
#[derive(Deserialize)]
struct GqlComment {
    #[serde(rename = "databaseId")]
    database_id: Option<u64>,
    body: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    url: Option<String>,
    #[serde(rename = "diffHunk")]
    diff_hunk: Option<String>,
    #[serde(rename = "pullRequestReview")]
    pull_request_review: Option<GqlReviewRef>,
    author: Option<GqlAuthor>,
}
#[derive(Deserialize)]
struct GqlReviewRef {
    #[serde(rename = "databaseId")]
    database_id: Option<u64>,
}
#[derive(Deserialize)]
struct GqlAuthor {
    login: String,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
}

async fn graphql<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    token: &str,
    query: &str,
    variables: serde_json::Value,
    context: &str,
) -> AppResult<T> {
    let resp = client
        .post(GRAPHQL)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error(context, resp).await);
    }
    let parsed: GqlResp<T> = resp.json().await?;
    if let Some(errors) = parsed.errors {
        return Err(AppError::Other(format!(
            "GitHub GraphQL ({context}): {errors}"
        )));
    }
    parsed
        .data
        .ok_or_else(|| AppError::Other(format!("GitHub GraphQL ({context}): no data")))
}

/// Inline review comment threads (grouped comments + replies + resolved state).
#[tauri::command]
pub async fn github_review_threads(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
) -> AppResult<Vec<ReviewThread>> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let data: GqlThreadsData = graphql(
        &client,
        &token,
        THREADS_QUERY,
        serde_json::json!({ "owner": owner, "repo": repo, "number": number }),
        "loading review threads",
    )
    .await?;

    let nodes = data
        .repository
        .and_then(|r| r.pull_request)
        .map(|p| p.review_threads.nodes)
        .unwrap_or_default();

    Ok(nodes
        .into_iter()
        .map(|t| {
            let first = t.comments.nodes.first();
            let diff_hunk = first.and_then(|c| c.diff_hunk.clone());
            let review_id = first
                .and_then(|c| c.pull_request_review.as_ref())
                .and_then(|p| p.database_id);
            ReviewThread {
                id: t.id,
                is_resolved: t.is_resolved,
                is_outdated: t.is_outdated,
                path: t.path,
                line: t.line.or(t.original_line),
                diff_hunk,
                review_id,
                comments: t
                    .comments
                    .nodes
                    .into_iter()
                    .map(|c| ThreadComment {
                        id: c.database_id,
                        author: c
                            .author
                            .as_ref()
                            .map(|a| a.login.clone())
                            .unwrap_or_else(|| "ghost".into()),
                        author_avatar: c.author.and_then(|a| a.avatar_url),
                        body: c.body,
                        created_at: c.created_at,
                        url: c.url,
                    })
                    .collect(),
            }
        })
        .collect())
}

/// Reply to an existing inline review comment thread (REST).
#[tauri::command]
pub async fn github_reply_review_comment(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    comment_id: u64,
    body: String,
) -> AppResult<()> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let resp = client
        .post(format!(
            "{API}/repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies"
        ))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "body": body }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("posting the reply", resp).await);
    }
    Ok(())
}

const RESOLVE_MUTATION: &str =
    "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id}}}";
const UNRESOLVE_MUTATION: &str =
    "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id}}}";

#[derive(Deserialize)]
struct GqlIgnore {}

/// Resolve or unresolve a review thread by its GraphQL node id.
#[tauri::command]
pub async fn github_resolve_thread(
    state: State<'_, AppState>,
    thread_id: String,
    resolved: bool,
) -> AppResult<()> {
    let token = require_token(&state)?;
    let client = http()?;
    let query = if resolved {
        RESOLVE_MUTATION
    } else {
        UNRESOLVE_MUTATION
    };
    let _: GqlIgnore = graphql(
        &client,
        &token,
        query,
        serde_json::json!({ "id": thread_id }),
        "updating the thread",
    )
    .await?;
    Ok(())
}

// ---- PR sidebar details (reviewers, assignees, labels, milestone, links) ----

#[derive(Serialize)]
pub struct Reviewer {
    pub login: String,
    pub avatar: Option<String>,
    pub state: String, // APPROVED | CHANGES_REQUESTED | COMMENTED | PENDING | DISMISSED
    pub re_requested: bool,
}
#[derive(Serialize)]
pub struct Person {
    pub login: String,
    pub avatar: Option<String>,
}
#[derive(Serialize)]
pub struct PrLabel {
    pub name: String,
    pub color: String,
}
#[derive(Serialize)]
pub struct LinkedIssue {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
}
#[derive(Serialize)]
pub struct PrDetails {
    pub reviewers: Vec<Reviewer>,
    pub assignees: Vec<Person>,
    pub labels: Vec<PrLabel>,
    pub milestone: Option<String>,
    pub linked_issues: Vec<LinkedIssue>,
}

const DETAILS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewRequests(first:50){ nodes{ requestedReviewer{ __typename ... on User{ login avatarUrl } ... on Team{ name } } } }
      latestReviews(first:50){ nodes{ author{ login avatarUrl } state } }
      assignees(first:20){ nodes{ login avatarUrl } }
      labels(first:50){ nodes{ name color } }
      milestone{ title }
      closingIssuesReferences(first:20){ nodes{ number title url state } }
    }
  }
}"#;

#[derive(Deserialize)]
struct GqlDetailsData {
    repository: Option<GqlDetailsRepo>,
}
#[derive(Deserialize)]
struct GqlDetailsRepo {
    #[serde(rename = "pullRequest")]
    pull_request: Option<GqlDetailsPr>,
}
#[derive(Deserialize)]
struct GqlDetailsPr {
    #[serde(rename = "reviewRequests")]
    review_requests: GqlConn<GqlReviewRequest>,
    #[serde(rename = "latestReviews")]
    latest_reviews: GqlConn<GqlLatestReview>,
    assignees: GqlConn<GqlAuthor>,
    labels: GqlConn<GqlLabel>,
    milestone: Option<GqlMilestone>,
    #[serde(rename = "closingIssuesReferences")]
    closing: GqlConn<GqlIssueRef>,
}
#[derive(Deserialize)]
struct GqlReviewRequest {
    #[serde(rename = "requestedReviewer")]
    requested_reviewer: Option<GqlReviewer>,
}
#[derive(Deserialize)]
struct GqlReviewer {
    login: Option<String>,
    #[serde(rename = "avatarUrl")]
    avatar_url: Option<String>,
    name: Option<String>,
}
#[derive(Deserialize)]
struct GqlLatestReview {
    author: Option<GqlAuthor>,
    state: String,
}
#[derive(Deserialize)]
struct GqlLabel {
    name: String,
    color: String,
}
#[derive(Deserialize)]
struct GqlMilestone {
    title: String,
}
#[derive(Deserialize)]
struct GqlIssueRef {
    number: u64,
    title: String,
    url: String,
    state: String,
}

/// Read-only PR sidebar metadata (reviewers + states, assignees, labels,
/// milestone, and linked "closing" issues), fetched in one GraphQL call.
#[tauri::command]
pub async fn github_pr_details(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
) -> AppResult<PrDetails> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let data: GqlDetailsData = graphql(
        &client,
        &token,
        DETAILS_QUERY,
        serde_json::json!({ "owner": owner, "repo": repo, "number": number }),
        "loading PR details",
    )
    .await?;

    let pr = match data.repository.and_then(|r| r.pull_request) {
        Some(pr) => pr,
        None => {
            return Ok(PrDetails {
                reviewers: vec![],
                assignees: vec![],
                labels: vec![],
                milestone: None,
                linked_issues: vec![],
            })
        }
    };

    // Reviews keyed by reviewer login, so requested reviewers can be matched.
    use std::collections::{HashMap, HashSet};
    let mut reviewed: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut review_order: Vec<String> = Vec::new();
    for r in pr.latest_reviews.nodes {
        if let Some(a) = r.author {
            if !reviewed.contains_key(&a.login) {
                review_order.push(a.login.clone());
            }
            reviewed.insert(a.login, (r.state, a.avatar_url));
        }
    }

    let mut reviewers: Vec<Reviewer> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for req in pr.review_requests.nodes {
        let Some(rv) = req.requested_reviewer else {
            continue;
        };
        let login = match (rv.login, rv.name) {
            (Some(l), _) => l,
            (None, Some(n)) => n,
            _ => continue,
        };
        let prior = reviewed.get(&login);
        let re_requested = prior.is_some();
        let state = prior
            .map(|p| p.0.clone())
            .unwrap_or_else(|| "PENDING".into());
        let avatar = rv.avatar_url.or_else(|| prior.and_then(|p| p.1.clone()));
        seen.insert(login.clone());
        reviewers.push(Reviewer {
            login,
            avatar,
            state,
            re_requested,
        });
    }
    for login in review_order {
        if seen.contains(&login) {
            continue;
        }
        if let Some((state, avatar)) = reviewed.remove(&login) {
            reviewers.push(Reviewer {
                login,
                avatar,
                state,
                re_requested: false,
            });
        }
    }

    Ok(PrDetails {
        reviewers,
        assignees: pr
            .assignees
            .nodes
            .into_iter()
            .map(|a| Person {
                login: a.login,
                avatar: a.avatar_url,
            })
            .collect(),
        labels: pr
            .labels
            .nodes
            .into_iter()
            .map(|l| PrLabel {
                name: l.name,
                color: l.color,
            })
            .collect(),
        milestone: pr.milestone.map(|m| m.title),
        linked_issues: pr
            .closing
            .nodes
            .into_iter()
            .map(|i| LinkedIssue {
                number: i.number,
                title: i.title,
                url: i.url,
                state: i.state,
            })
            .collect(),
    })
}

/// Merge a pull request. `method` is "merge" | "squash" | "rebase".
#[tauri::command]
pub async fn github_merge_pr(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    method: String,
) -> AppResult<()> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let client = http()?;
    let resp = client
        .put(format!("{API}/repos/{owner}/{repo}/pulls/{number}/merge"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "merge_method": method }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("merging the pull request", resp).await);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{https_host, is_github_asset_host, parse_owner_repo, parse_pr_url, split_remote};

    #[test]
    fn extracts_https_host() {
        assert_eq!(
            https_host("https://github.com/user-attachments/assets/abc"),
            Some("github.com".to_string())
        );
        assert_eq!(
            https_host("https://private-user-images.githubusercontent.com/1/2?jwt=x"),
            Some("private-user-images.githubusercontent.com".to_string())
        );
        // userinfo and port are stripped; host is lowercased.
        assert_eq!(
            https_host("https://user@GitHub.com:443/x"),
            Some("github.com".to_string())
        );
        // Non-https (e.g. data:, http:) is not proxied.
        assert_eq!(https_host("http://github.com/x"), None);
        assert_eq!(https_host("data:image/png;base64,AAAA"), None);
    }

    #[test]
    fn recognizes_github_asset_hosts() {
        for host in [
            "github.com",
            "githubusercontent.com",
            "private-user-images.githubusercontent.com",
            "user-images.githubusercontent.com",
            "camo.githubusercontent.com",
        ] {
            assert!(is_github_asset_host(host), "should accept {host}");
        }
        // Anything else must be rejected so the token isn't leaked to it.
        for host in [
            "evil.com",
            "githubusercontent.com.evil.com",
            "notgithub.com",
            "raw.githubusercontent.com.attacker.net",
        ] {
            assert!(!is_github_asset_host(host), "should reject {host}");
        }
    }

    #[test]
    fn splits_arbitrary_host_aliases() {
        // split_remote is host-agnostic: it extracts owner/repo even for an
        // arbitrarily-named SSH alias. owner_repo then resolves the alias via
        // `ssh -G` to decide whether it's really GitHub.
        assert_eq!(
            split_remote("mygit:rymera/gamut.git"),
            Some((
                "mygit".to_string(),
                "rymera".to_string(),
                "gamut".to_string()
            ))
        );
        assert_eq!(
            split_remote("ssh://git@mygit/rymera/gamut.git"),
            Some((
                "mygit".to_string(),
                "rymera".to_string(),
                "gamut".to_string()
            ))
        );
    }

    #[test]
    fn parses_github_remotes() {
        let cases = [
            "https://github.com/rymera/gamut.git",
            "https://github.com/rymera/gamut",
            "git@github.com:rymera/gamut.git",
            "ssh://git@github.com/rymera/gamut.git",
            // Custom SSH host aliases that resolve to github.com (issue #4).
            "rymera.github.com:rymera/gamut.git",
            "rymera.github.com:rymera/gamut",
            "git@rymera.github.com:rymera/gamut.git",
            "ssh://git@rymera.github.com/rymera/gamut.git",
            "github.com-work:rymera/gamut.git",
        ];
        for c in cases {
            assert_eq!(
                parse_owner_repo(c),
                Some(("rymera".to_string(), "gamut".to_string())),
                "failed for {c}"
            );
        }
        // Genuinely non-GitHub remotes must still be rejected.
        assert_eq!(parse_owner_repo("https://gitlab.com/x/y.git"), None);
        assert_eq!(parse_owner_repo("git@gitlab.com:x/y.git"), None);
        assert_eq!(parse_owner_repo("rymera.gitlab.com:x/y.git"), None);
    }

    #[test]
    fn parses_pr_urls() {
        // Canonical PR URL plus trailing path, query and fragment variants.
        for url in [
            "https://github.com/Rymera-Web-Co/Gamut/pull/51",
            "https://github.com/Rymera-Web-Co/Gamut/pull/51/files",
            "https://github.com/Rymera-Web-Co/Gamut/pull/51#discussion_r123",
            "https://github.com/Rymera-Web-Co/Gamut/pull/51?w=1",
        ] {
            assert_eq!(
                parse_pr_url(url),
                Some(("Rymera-Web-Co".to_string(), "Gamut".to_string(), 51)),
                "failed for {url}"
            );
        }
        // Custom github host alias is still GitHub.
        assert_eq!(
            parse_pr_url("https://github.com-work/o/r/pull/7"),
            Some(("o".to_string(), "r".to_string(), 7))
        );
    }

    #[test]
    fn rejects_non_pr_urls() {
        for url in [
            // Not a PR path.
            "https://github.com/o/r/issues/3",
            "https://github.com/o/r/commit/abc",
            "https://github.com/o/r",
            // Non-numeric / missing PR number.
            "https://github.com/o/r/pull/",
            "https://github.com/o/r/pull/abc",
            // Non-GitHub host.
            "https://gitlab.com/o/r/pull/3",
            // Non-https (terminal links can be http; PR deep-linking is https-only).
            "http://github.com/o/r/pull/3",
        ] {
            assert_eq!(parse_pr_url(url), None, "should reject {url}");
        }
    }
}
