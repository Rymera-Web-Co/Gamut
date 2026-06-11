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
    Ok(reqwest::Client::builder()
        .user_agent("gamut")
        .build()?)
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
/// secret), so it's safe to commit. Override at runtime with GAMUT_GITHUB_CLIENT_ID.
const DEFAULT_CLIENT_ID: &str = "Ov23liVS0gVXFvhvRpvC";

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

fn parse_owner_repo(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("git@github.com:"))
        .or_else(|| u.strip_prefix("ssh://git@github.com/"))?;
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.trim_end_matches('/').to_string();
    if owner.is_empty() || repo.is_empty() {
        None
    } else {
        Some((owner, repo))
    }
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
    parse_owner_repo(url)
        .ok_or_else(|| AppError::Other(format!("origin is not a GitHub remote: {url}")))
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
        .form(&[("client_id", cid.as_str()), ("scope", "repo")])
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
    let cid = client_id().ok_or_else(|| AppError::Other("GitHub OAuth is not configured".into()))?;
    let client = http()?;
    let mut wait = interval.max(5);
    let mut elapsed = 0u64;

    loop {
        sleep(Duration::from_secs(wait)).await;
        elapsed += wait;
        if elapsed > expires_in {
            return Err(AppError::Other("authorization timed out — please try again".into()));
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
                return Err(AppError::Other("the code expired — please try again".into()))
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
pub async fn github_set_token(
    state: State<'_, AppState>,
    token: String,
) -> AppResult<AuthStatus> {
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
        .post(format!("{API}/repos/{owner}/{repo}/pulls/{number}/comments"))
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
            nodes{ databaseId body createdAt url diffHunk author{ login avatarUrl } }
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
    author: Option<GqlAuthor>,
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
        return Err(AppError::Other(format!("GitHub GraphQL ({context}): {errors}")));
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
            let diff_hunk = t.comments.nodes.first().and_then(|c| c.diff_hunk.clone());
            ReviewThread {
                id: t.id,
                is_resolved: t.is_resolved,
                is_outdated: t.is_outdated,
                path: t.path,
                line: t.line.or(t.original_line),
                diff_hunk,
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

#[cfg(test)]
mod tests {
    use super::parse_owner_repo;

    #[test]
    fn parses_github_remotes() {
        let cases = [
            "https://github.com/rymera/gamut.git",
            "https://github.com/rymera/gamut",
            "git@github.com:rymera/gamut.git",
            "ssh://git@github.com/rymera/gamut.git",
        ];
        for c in cases {
            assert_eq!(
                parse_owner_repo(c),
                Some(("rymera".to_string(), "gamut".to_string())),
                "failed for {c}"
            );
        }
        assert_eq!(parse_owner_repo("https://gitlab.com/x/y.git"), None);
    }
}
