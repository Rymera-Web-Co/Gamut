use std::time::Duration;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::time::sleep;

use crate::commands::history::open_repo;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const KEYRING_SERVICE: &str = "com.rymera.gamut";
const KEYRING_USER: &str = "github-token";
const API: &str = "https://api.github.com";

// ---- Token storage (OS keychain) ----

fn token_entry() -> AppResult<Entry> {
    Ok(Entry::new(KEYRING_SERVICE, KEYRING_USER)?)
}

fn read_token() -> AppResult<Option<String>> {
    match token_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn http() -> AppResult<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent("gamut")
        .build()?)
}

fn require_token() -> AppResult<String> {
    read_token()?.ok_or_else(|| AppError::Other("not signed in to GitHub".into()))
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
            token_entry()?.set_password(&token)?;
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
    pub url: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct PrComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub kind: String, // "comment" | "review"
    pub state: Option<String>,
}

#[derive(Serialize)]
pub struct PrThread {
    pub title: String,
    pub author: String,
    pub state: String, // "open" | "closed" | "merged"
    pub body: String,
    pub created_at: String,
    pub comments: Vec<PrComment>,
}

// ---- GitHub API response shapes ----

#[derive(Deserialize)]
struct GhUser {
    login: String,
}

#[derive(Deserialize)]
struct GhRef {
    #[serde(rename = "ref")]
    ref_name: String,
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
    user: GhUser,
    body: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct GhReview {
    user: GhUser,
    body: Option<String>,
    state: String,
    submitted_at: Option<String>,
}

// ---- Commands ----

/// Validate and store a GitHub personal-access token in the OS keychain.
#[tauri::command]
pub async fn github_set_token(token: String) -> AppResult<AuthStatus> {
    let client = http()?;
    let resp = client
        .get(format!("{API}/user"))
        .bearer_auth(&token)
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
    token_entry()?.set_password(&token)?;
    Ok(AuthStatus {
        logged_in: true,
        login: Some(user.login),
    })
}

#[tauri::command]
pub async fn github_auth_status() -> AppResult<AuthStatus> {
    let Some(token) = read_token()? else {
        return Ok(AuthStatus {
            logged_in: false,
            login: None,
        });
    };
    let client = http()?;
    let resp = client
        .get(format!("{API}/user"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    if !resp.status().is_success() {
        return Ok(AuthStatus {
            logged_in: false,
            login: None,
        });
    }
    let user: GhUser = resp.json().await?;
    Ok(AuthStatus {
        logged_in: true,
        login: Some(user.login),
    })
}

#[tauri::command]
pub fn github_logout() -> AppResult<()> {
    match token_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// List open pull requests for the repo's GitHub origin.
#[tauri::command]
pub async fn github_list_prs(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<PrSummary>> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token()?;
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
            url: p.html_url,
            updated_at: p.updated_at,
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
    let token = require_token()?;
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
    let token = require_token()?;
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

    let mut comments: Vec<PrComment> = Vec::new();
    for c in issue_comments {
        comments.push(PrComment {
            author: c.user.login,
            body: c.body.unwrap_or_default(),
            created_at: c.created_at,
            kind: "comment".to_string(),
            state: None,
        });
    }
    for r in reviews {
        let body = r.body.unwrap_or_default();
        // Skip empty drive-by "commented" reviews (just inline comments).
        if body.is_empty() && r.state == "COMMENTED" {
            continue;
        }
        comments.push(PrComment {
            author: r.user.login,
            body,
            created_at: r.submitted_at.unwrap_or_default(),
            kind: "review".to_string(),
            state: Some(r.state),
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
        comments,
    })
}

/// Submit a review on a pull request. `event` is APPROVE | REQUEST_CHANGES | COMMENT.
#[tauri::command]
pub async fn github_submit_review(
    state: State<'_, AppState>,
    repo_id: i64,
    number: u64,
    event: String,
    body: String,
) -> AppResult<()> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token()?;
    let client = http()?;
    let resp = client
        .post(format!("{API}/repos/{owner}/{repo}/pulls/{number}/reviews"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .json(&serde_json::json!({ "event": event, "body": body }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(api_error("submitting the review", resp).await);
    }
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
