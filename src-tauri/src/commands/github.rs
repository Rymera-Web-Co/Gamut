use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::State;

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
        return Err(AppError::Other(format!(
            "GitHub returned {} listing pull requests",
            resp.status()
        )));
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
        return Err(AppError::Other(format!(
            "GitHub returned {} fetching PR diff",
            resp.status()
        )));
    }
    Ok(resp.text().await?)
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
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "GitHub returned {status} submitting review: {text}"
        )));
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
