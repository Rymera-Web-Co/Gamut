//! GitHub integration commands, split into cohesive submodules (#138):
//!
//! - [`remote`] — pure remote-URL / host parsing (no `State`).
//! - [`auth`] — token storage (keychain / settings) and the OAuth device flow.
//! - [`rest`] — REST pull-request operations and the attachment image proxy.
//! - [`graphql`] — GraphQL review threads and PR sidebar details.
//!
//! This module holds the shared plumbing those submodules build on (HTTP
//! client, settings/endpoint config, the rate-limit-aware error builder, and
//! `origin` owner/repo resolution) and re-exports every `#[tauri::command]` so
//! the `commands::github::*` paths used by the invoke handler stay stable.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::commands::history::open_repo;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

mod auth;
mod graphql;
mod remote;
mod rest;

pub use auth::*;
pub use graphql::*;
pub use rest::*;

use remote::{
    parse_owner_repo, parse_pr_url, remote_web_url, split_remote, ssh_alias_resolves_to_github,
};

const DEFAULT_API: &str = "https://api.github.com";
const DEFAULT_GRAPHQL: &str = "https://api.github.com/graphql";

// User-configurable endpoints for GitHub Enterprise Server (issue #34). Empty /
// unset falls back to github.com. The OAuth device-flow endpoints stay on
// github.com (they target the Rymera OAuth app); GHES users sign in with a PAT.
const PREF_API_BASE: &str = "pref.githubApiBase";
const PREF_GRAPHQL_BASE: &str = "pref.githubGraphqlBase";
const PREF_PR_PAGE_SIZE: &str = "pref.githubPrPageSize";

/// Trim a configured base URL (drop surrounding space and any trailing `/`),
/// falling back to `default` when unset or blank.
fn normalize_base(value: Option<String>, default: &str) -> String {
    value
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

/// Configured REST API base (no trailing slash) — `api.github.com` by default.
fn api_base(state: &AppState) -> String {
    normalize_base(
        get_setting(state, PREF_API_BASE).ok().flatten(),
        DEFAULT_API,
    )
}

/// Configured GraphQL endpoint — `api.github.com/graphql` by default.
fn graphql_url(state: &AppState) -> String {
    normalize_base(
        get_setting(state, PREF_GRAPHQL_BASE).ok().flatten(),
        DEFAULT_GRAPHQL,
    )
}

/// Open PRs to fetch per repo (clamped to GitHub's 1–100 page bound).
fn pr_page_size(state: &AppState) -> u32 {
    get_setting(state, PREF_PR_PAGE_SIZE)
        .ok()
        .flatten()
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|n| (1..=100).contains(n))
        .unwrap_or(50)
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

/// A cached GitHub avatar for a commit-author email (#195). Distinguishes three
/// states so callers can avoid both re-fetching and mis-caching:
/// - `None` — no cache row: the email hasn't been resolved yet, so fetch it.
/// - `Some(None)` — cached negative: the email maps to no GitHub account; a
///   real, stable result worth caching so history browsing stops retrying it.
/// - `Some(Some(url))` — cached avatar URL.
pub(super) fn cached_avatar(state: &AppState, email: &str) -> AppResult<Option<Option<String>>> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    cached_avatar_conn(&conn, email)
}

/// Record the GitHub identity resolved for a commit-author email (#195).
/// `avatar` may be `None` — a cached negative (see [`cached_avatar`]).
pub(super) fn store_avatar(
    state: &AppState,
    email: &str,
    login: Option<&str>,
    avatar: Option<&str>,
) -> AppResult<()> {
    let conn = state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))?;
    store_avatar_conn(&conn, email, login, avatar)
}

/// SQL body of [`cached_avatar`], split out so it can be exercised against a bare
/// connection in tests without constructing an [`AppState`].
fn cached_avatar_conn(
    conn: &rusqlite::Connection,
    email: &str,
) -> AppResult<Option<Option<String>>> {
    Ok(conn
        .query_row(
            "SELECT avatar_url FROM gh_user_cache WHERE email = ?1",
            [email],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?)
}

/// SQL body of [`store_avatar`] (see [`cached_avatar_conn`]).
fn store_avatar_conn(
    conn: &rusqlite::Connection,
    email: &str,
    login: Option<&str>,
    avatar: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO gh_user_cache (email, login, avatar_url, fetched_at)
         VALUES (?1, ?2, ?3, strftime('%s', 'now'))
         ON CONFLICT(email) DO UPDATE SET
             login = excluded.login,
             avatar_url = excluded.avatar_url,
             fetched_at = excluded.fetched_at",
        rusqlite::params![email, login, avatar],
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

/// Read a response header as an owned string, if present and valid UTF-8.
fn header_str(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

/// Seconds to wait before retrying a rate-limited request: GitHub's
/// `Retry-After` (secondary limits) if present, else `X-RateLimit-Reset`
/// (an epoch second for primary limits) minus now.
fn retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    if let Some(secs) =
        header_str(headers, "retry-after").and_then(|s| s.trim().parse::<u64>().ok())
    {
        return Some(secs);
    }
    let reset = header_str(headers, "x-ratelimit-reset")?
        .trim()
        .parse::<u64>()
        .ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some(reset.saturating_sub(now))
}

/// Build a descriptive error from a failed GitHub response: include GitHub's
/// own `message`, and surface the SSO header when org SAML authorization is
/// required (GitHub returns 403 with `x-github-sso` in that case).
async fn api_error(context: &str, resp: reqwest::Response) -> AppError {
    let status = resp.status();
    let headers = resp.headers();
    // Rate limiting: GitHub signals it with 403/429 plus either
    // `X-RateLimit-Remaining: 0` (primary) or `Retry-After` (secondary). Detect
    // it before reading the body so users get a clear, actionable message with a
    // wait time instead of an opaque "GitHub 403" (#135). Returned as the typed
    // `RateLimited` variant so retry logic / the UI can distinguish it (#138).
    let rate_limited = matches!(status.as_u16(), 403 | 429)
        && (header_str(headers, "retry-after").is_some()
            || header_str(headers, "x-ratelimit-remaining").as_deref() == Some("0"));
    if rate_limited {
        let retry = match retry_after_secs(headers) {
            Some(secs) => format!("retry in {secs}s"),
            None => "retry shortly".to_string(),
        };
        return AppError::RateLimited {
            context: context.to_string(),
            retry,
        };
    }
    let sso = header_str(headers, "x-github-sso");
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

// ---- Remote resolution ----
//
// The pure URL/host parsers (`split_remote`, `parse_pr_url`, `is_github_host`,
// `https_host`, `is_github_asset_host`, `parse_owner_repo`,
// `ssh_alias_resolves_to_github`) live in the `remote` submodule (#138);
// `owner_repo` stays here because it needs `State` to read the repo's origin.

/// Resolve the GitHub owner/repo from the repo's `origin` remote, memoizing the
/// result. `owner_repo` is called at the top of ~15 GitHub commands and once per
/// registered repo by PR-link resolution; without the cache each call re-opens
/// the repo and re-parses `origin` (#136). Only successful resolutions are
/// cached, keyed by `repo_id`; [`crate::commands::repo`] clears entries on
/// register/remove.
fn owner_repo(state: &State<AppState>, repo_id: i64) -> AppResult<(String, String)> {
    if let Ok(cache) = state.origin_slug_cache.lock() {
        if let Some(hit) = cache.get(&repo_id) {
            return Ok(hit.clone());
        }
    }
    let resolved = owner_repo_uncached(state, repo_id)?;
    if let Ok(mut cache) = state.origin_slug_cache.lock() {
        cache.insert(repo_id, resolved.clone());
    }
    Ok(resolved)
}

/// Resolve the GitHub owner/repo from the repo's `origin` remote (no cache).
fn owner_repo_uncached(state: &State<AppState>, repo_id: i64) -> AppResult<(String, String)> {
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

/// The `https://` web URL of the repo's `origin` remote (GitHub, GitLab,
/// Bitbucket, self-hosted…), for the repo sidebar's "Open remote repo" action.
/// `git@…` / `ssh://` remotes are normalized to their browser-openable form.
/// Returns `None` when the repo has no `origin` remote or its URL can't be
/// parsed, so the caller hides the menu item rather than showing a dead entry.
#[tauri::command]
pub fn repo_remote_url(state: State<AppState>, repo_id: i64) -> AppResult<Option<String>> {
    let repo = open_repo(&state, repo_id)?;
    let Ok(remote) = repo.find_remote("origin") else {
        return Ok(None);
    };
    Ok(remote.url().and_then(remote_web_url))
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

// ---- Shared GitHub API response shapes ----

/// A GitHub user as it appears across REST payloads (PR authors, comment
/// authors, assignees, …) and the auth `/user` check.
#[derive(Deserialize)]
struct GhUser {
    login: String,
    avatar_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{cached_avatar_conn, normalize_base, store_avatar_conn, DEFAULT_API};

    /// An in-memory DB with the `gh_user_cache` schema (via the real migration).
    fn cache_db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("../../db/migrations/0006_gh_user_cache.sql"))
            .unwrap();
        conn
    }

    #[test]
    fn avatar_cache_distinguishes_miss_hit_and_negative() {
        let conn = cache_db();

        // Miss: no row yet → the caller must fetch.
        assert_eq!(cached_avatar_conn(&conn, "ada@example.com").unwrap(), None);

        // Positive: a resolved avatar round-trips.
        store_avatar_conn(
            &conn,
            "ada@example.com",
            Some("ada"),
            Some("https://avatars.example/ada.png"),
        )
        .unwrap();
        assert_eq!(
            cached_avatar_conn(&conn, "ada@example.com").unwrap(),
            Some(Some("https://avatars.example/ada.png".into()))
        );

        // Negative: an email with no GitHub account caches as a present row with
        // a NULL avatar — distinct from a miss, so it isn't retried forever.
        store_avatar_conn(&conn, "nobody@example.com", None, None).unwrap();
        assert_eq!(
            cached_avatar_conn(&conn, "nobody@example.com").unwrap(),
            Some(None)
        );
    }

    #[test]
    fn avatar_cache_upserts_on_repeat() {
        let conn = cache_db();
        store_avatar_conn(&conn, "ada@example.com", Some("ada"), Some("old.png")).unwrap();
        store_avatar_conn(&conn, "ada@example.com", Some("ada"), Some("new.png")).unwrap();
        assert_eq!(
            cached_avatar_conn(&conn, "ada@example.com").unwrap(),
            Some(Some("new.png".into()))
        );
        // The upsert replaces, it doesn't duplicate the primary key.
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM gh_user_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn normalizes_configured_base() {
        // Unset / blank / whitespace-only fall back to the default.
        assert_eq!(normalize_base(None, DEFAULT_API), DEFAULT_API);
        assert_eq!(normalize_base(Some("".into()), DEFAULT_API), DEFAULT_API);
        assert_eq!(normalize_base(Some("   ".into()), DEFAULT_API), DEFAULT_API);
        // A configured value is trimmed and stripped of any trailing slash.
        assert_eq!(
            normalize_base(Some("https://ghe.example.com/api/v3/".into()), DEFAULT_API),
            "https://ghe.example.com/api/v3"
        );
        assert_eq!(
            normalize_base(
                Some("  https://ghe.example.com/api/v3  ".into()),
                DEFAULT_API
            ),
            "https://ghe.example.com/api/v3"
        );
    }
}
