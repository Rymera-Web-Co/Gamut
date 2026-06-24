//! GitHub REST operations: pull-request listing/diff/threads/timeline, review
//! submission, body edits, mentionables, the image proxy, and merge. Split out
//! of the github module for navigability (#138).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::auth::require_token;
use super::remote::{https_host, is_github_asset_host};
use super::{api_base, api_error, header_str, http, owner_repo, pr_page_size, GhUser};

/// Parse the `next` page URL from a REST `Link` header value, if present.
/// e.g. `<https://api.github.com/…&page=2>; rel="next", <…>; rel="last"`.
fn parse_next_link(link: &str) -> Option<String> {
    link.split(',').find_map(|part| {
        let mut segs = part.split(';');
        let url = segs.next()?.trim();
        segs.any(|s| s.trim() == "rel=\"next\"").then(|| {
            url.trim_start_matches('<')
                .trim_end_matches('>')
                .to_string()
        })
    })
}

/// The `next` page URL from a response's `Link` header, if any.
fn next_page_url(headers: &reqwest::header::HeaderMap) -> Option<String> {
    parse_next_link(&header_str(headers, "link")?)
}

/// GET a paginated REST collection, following `Link: rel="next"` to the last
/// page so items past the first `per_page` aren't silently dropped (#135).
/// `first_url` should already carry its query (including `per_page`); GitHub's
/// `next` links preserve it.
async fn get_all_pages<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    token: &str,
    first_url: String,
    context: &str,
) -> AppResult<Vec<T>> {
    let mut url = Some(first_url);
    let mut out = Vec::new();
    while let Some(current) = url {
        let resp = client
            .get(&current)
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(api_error(context, resp).await);
        }
        let next = next_page_url(resp.headers());
        let page: Vec<T> = resp.json().await?;
        // Stop at the last page — or defensively if a page comes back empty.
        url = if page.is_empty() { None } else { next };
        out.extend(page);
    }
    Ok(out)
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

/// List open pull requests for the repo's GitHub origin.
#[tauri::command]
pub async fn github_list_prs(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<Vec<PrSummary>> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let api = api_base(&state);
    let per_page = pr_page_size(&state).to_string();
    let client = http()?;
    let resp = client
        .get(format!("{api}/repos/{owner}/{repo}/pulls"))
        .query(&[("state", "open"), ("per_page", per_page.as_str())])
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
    let api = api_base(&state);
    let client = http()?;
    let resp = client
        .get(format!("{api}/repos/{owner}/{repo}/pulls/{number}"))
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
    let api = api_base(&state);
    let client = http()?;
    let base = format!("{api}/repos/{owner}/{repo}");

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

    // Follow pagination so a PR with >100 issue comments or >100 reviews keeps
    // the full conversation (#135). Errors stay non-fatal (empty), matching the
    // prior behavior — the PR header still renders without its comment list.
    let issue_comments: Vec<GhIssueComment> = get_all_pages(
        &client,
        &token,
        format!("{base}/issues/{number}/comments?per_page=100"),
        "loading PR comments",
    )
    .await
    .unwrap_or_default();

    let reviews: Vec<GhReview> = get_all_pages(
        &client,
        &token,
        format!("{base}/pulls/{number}/reviews?per_page=100"),
        "loading PR reviews",
    )
    .await
    .unwrap_or_default();

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
    let api = api_base(&state);
    let client = http()?;

    // Follow `Link: rel="next"` to the end rather than capping at a fixed page
    // count, so a long-lived PR's timeline isn't silently truncated (#135).
    let raw: Vec<serde_json::Value> = get_all_pages(
        &client,
        &token,
        format!("{api}/repos/{owner}/{repo}/issues/{number}/timeline?per_page=100"),
        "loading the PR timeline",
    )
    .await?;

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
    let api = api_base(&state);
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
        .post(format!("{api}/repos/{owner}/{repo}/pulls/{number}/reviews"))
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
    let api = api_base(&state);
    let client = http()?;

    let mut payload = comment_json(&comment);
    if let serde_json::Value::Object(ref mut m) = payload {
        m.insert("commit_id".into(), serde_json::json!(commit_id));
    }

    let resp = client
        .post(format!(
            "{api}/repos/{owner}/{repo}/pulls/{number}/comments"
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
    let api = api_base(&state);
    let client = http()?;
    let base = format!("{api}/repos/{owner}/{repo}");

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
    let api = api_base(&state);
    let client = http()?;
    // Follow pagination so repos with >100 assignees don't lose the rest from
    // @-mention autocomplete (#135).
    let users: Vec<GhUser> = get_all_pages(
        &client,
        &token,
        format!("{api}/repos/{owner}/{repo}/assignees?per_page=100"),
        "listing mentionable users",
    )
    .await?;
    Ok(users.into_iter().map(|u| u.login).collect())
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
    let api = api_base(&state);
    let client = http()?;
    let resp = client
        .post(format!(
            "{api}/repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies"
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

/// Whether `branch` still exists on the repo's GitHub `origin`. Used by the
/// post-merge cleanup (#132) to decide whether GitHub auto-deleted the head
/// branch: a 404 means the remote branch is gone, so deleting the local copy is
/// safe; if it still exists, the local branch is kept.
#[tauri::command]
pub async fn github_remote_branch_exists(
    state: State<'_, AppState>,
    repo_id: i64,
    branch: String,
) -> AppResult<bool> {
    let (owner, repo) = owner_repo(&state, repo_id)?;
    let token = require_token(&state)?;
    let api = api_base(&state);
    let client = http()?;
    let resp = client
        .get(format!("{api}/repos/{owner}/{repo}/branches/{branch}"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
    match resp.status() {
        s if s.is_success() => Ok(true),
        reqwest::StatusCode::NOT_FOUND => Ok(false),
        _ => Err(api_error("checking the remote branch", resp).await),
    }
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
    let api = api_base(&state);
    let client = http()?;
    let resp = client
        .put(format!("{api}/repos/{owner}/{repo}/pulls/{number}/merge"))
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
    use super::parse_next_link;

    #[test]
    fn parses_next_link_rel() {
        let link =
            "<https://api.github.com/repos/o/r/assignees?per_page=100&page=2>; rel=\"next\", \
             <https://api.github.com/repos/o/r/assignees?per_page=100&page=5>; rel=\"last\"";
        assert_eq!(
            parse_next_link(link).as_deref(),
            Some("https://api.github.com/repos/o/r/assignees?per_page=100&page=2")
        );
        // Last page: only prev/first links, no next.
        let last = "<https://api.github.com/x?page=4>; rel=\"prev\", \
             <https://api.github.com/x?page=1>; rel=\"first\"";
        assert_eq!(parse_next_link(last), None);
        assert_eq!(parse_next_link(""), None);
    }
}
