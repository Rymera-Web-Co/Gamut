//! GitHub GraphQL operations: inline review threads (grouped comments +
//! resolve/unresolve) and the PR sidebar details (reviewers, assignees, labels,
//! milestone, linked issues). Split out of the github module for navigability
//! (#138).

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::auth::require_token;
use super::{api_error, graphql_url, http, owner_repo};

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

const THREADS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{
          id isResolved isOutdated path line originalLine
          comments(first:100){
            pageInfo{ hasNextPage endCursor }
            nodes{ databaseId body createdAt url diffHunk pullRequestReview{ databaseId } author{ login avatarUrl } }
          }
        }
      }
    }
  }
}"#;

/// Follow-up query for a single thread whose comments exceeded the first page
/// (>100 replies). Pages the thread node's `comments` connection by cursor (#135).
const THREAD_COMMENTS_QUERY: &str = r#"
query($id:ID!,$after:String){
  node(id:$id){
    ... on PullRequestReviewThread{
      comments(first:100,after:$after){
        pageInfo{ hasNextPage endCursor }
        nodes{ databaseId body createdAt url diffHunk pullRequestReview{ databaseId } author{ login avatarUrl } }
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
    #[serde(rename = "pageInfo", default)]
    page_info: GqlPageInfo,
}
#[derive(Deserialize, Default)]
struct GqlPageInfo {
    #[serde(rename = "hasNextPage", default)]
    has_next_page: bool,
    #[serde(rename = "endCursor", default)]
    end_cursor: Option<String>,
}
/// Response shape for THREAD_COMMENTS_QUERY (`node(id:…)` → a review thread).
#[derive(Deserialize)]
struct GqlNodeData {
    node: Option<GqlThreadComments>,
}
#[derive(Deserialize)]
struct GqlThreadComments {
    comments: GqlConn<GqlComment>,
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
    url: &str,
    token: &str,
    query: &str,
    variables: serde_json::Value,
    context: &str,
) -> AppResult<T> {
    let resp = client
        .post(url)
        // The merge-info preview media type unlocks `mergeStateStatus` on the PR
        // type; harmless for the other GraphQL queries, which return JSON either way.
        .bearer_auth(token)
        .header(
            "Accept",
            "application/vnd.github+json, application/vnd.github.merge-info-preview+json",
        )
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
    let url = graphql_url(&state);

    // Page through the reviewThreads connection by cursor so a PR with >100
    // inline review threads keeps them all rather than dropping the overflow (#135).
    let mut nodes: Vec<GqlThread> = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let data: GqlThreadsData = graphql(
            &client,
            &url,
            &token,
            THREADS_QUERY,
            serde_json::json!({ "owner": owner, "repo": repo, "number": number, "after": after }),
            "loading review threads",
        )
        .await?;
        let Some(conn) = data
            .repository
            .and_then(|r| r.pull_request)
            .map(|p| p.review_threads)
        else {
            break;
        };
        let page = conn.page_info;
        nodes.extend(conn.nodes);
        match (page.has_next_page, page.end_cursor) {
            (true, Some(cursor)) => after = Some(cursor),
            _ => break,
        }
    }

    let mut out: Vec<ReviewThread> = Vec::with_capacity(nodes.len());
    for t in nodes {
        // A single thread can also overflow its first 100 comments; follow that
        // connection's cursor too so long discussions aren't truncated (#135).
        let mut comment_nodes = t.comments.nodes;
        let mut page = t.comments.page_info;
        while page.has_next_page {
            let Some(cursor) = page.end_cursor else { break };
            let data: GqlNodeData = graphql(
                &client,
                &url,
                &token,
                THREAD_COMMENTS_QUERY,
                serde_json::json!({ "id": t.id.clone(), "after": cursor }),
                "loading review thread comments",
            )
            .await?;
            let Some(node) = data.node else { break };
            comment_nodes.extend(node.comments.nodes);
            page = node.comments.page_info;
        }

        let first = comment_nodes.first();
        let diff_hunk = first.and_then(|c| c.diff_hunk.clone());
        let review_id = first
            .and_then(|c| c.pull_request_review.as_ref())
            .and_then(|p| p.database_id);
        out.push(ReviewThread {
            id: t.id,
            is_resolved: t.is_resolved,
            is_outdated: t.is_outdated,
            path: t.path,
            line: t.line.or(t.original_line),
            diff_hunk,
            review_id,
            comments: comment_nodes
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
        });
    }
    Ok(out)
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
        &graphql_url(&state),
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
/// A single CI / status check on the PR's head commit, normalized from either a
/// GraphQL `CheckRun` or a legacy `StatusContext`.
#[derive(Serialize)]
pub struct StatusCheck {
    pub name: String,
    /// One of SUCCESS | FAILURE | PENDING | NEUTRAL | ERROR.
    pub state: String,
    pub url: Option<String>,
}

/// The PR's roll-up merge requirements: review decision, mergeable / merge-state
/// status, draft flag, and the head commit's CI checks (#185).
#[derive(Serialize)]
pub struct MergeInfo {
    /// GraphQL reviewDecision: APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null.
    pub review_decision: Option<String>,
    /// MERGEABLE | CONFLICTING | UNKNOWN (UNKNOWN while GitHub is still computing).
    pub mergeable: String,
    /// CLEAN | UNSTABLE | BLOCKED | BEHIND | DIRTY | DRAFT | HAS_HOOKS | UNKNOWN.
    pub merge_state_status: String,
    pub is_draft: bool,
    /// Rolled-up check state: SUCCESS | FAILURE | PENDING | ERROR | EXPECTED | null.
    pub check_rollup: Option<String>,
    pub checks: Vec<StatusCheck>,
}

#[derive(Serialize)]
pub struct PrDetails {
    pub reviewers: Vec<Reviewer>,
    pub assignees: Vec<Person>,
    pub labels: Vec<PrLabel>,
    pub milestone: Option<String>,
    pub linked_issues: Vec<LinkedIssue>,
    pub merge: MergeInfo,
}

const DETAILS_QUERY: &str = r#"
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      isDraft
      reviewDecision
      mergeable
      mergeStateStatus
      reviewRequests(first:50){ nodes{ requestedReviewer{ __typename ... on User{ login avatarUrl } ... on Team{ name } } } }
      latestReviews(first:50){ nodes{ author{ login avatarUrl } state } }
      assignees(first:20){ nodes{ login avatarUrl } }
      labels(first:50){ nodes{ name color } }
      milestone{ title }
      closingIssuesReferences(first:20){ nodes{ number title url state } }
      commits(last:1){ nodes{ commit{ statusCheckRollup{
        state
        contexts(first:100){ nodes{
          __typename
          ... on CheckRun{ name status conclusion detailsUrl }
          ... on StatusContext{ context state targetUrl }
        } }
      } } } }
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
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(rename = "reviewDecision")]
    review_decision: Option<String>,
    mergeable: Option<String>,
    #[serde(rename = "mergeStateStatus")]
    merge_state_status: Option<String>,
    #[serde(rename = "reviewRequests")]
    review_requests: GqlConn<GqlReviewRequest>,
    #[serde(rename = "latestReviews")]
    latest_reviews: GqlConn<GqlLatestReview>,
    assignees: GqlConn<GqlAuthor>,
    labels: GqlConn<GqlLabel>,
    milestone: Option<GqlMilestone>,
    #[serde(rename = "closingIssuesReferences")]
    closing: GqlConn<GqlIssueRef>,
    commits: GqlConn<GqlCommitNode>,
}

#[derive(Deserialize)]
struct GqlCommitNode {
    commit: GqlCommit,
}
#[derive(Deserialize)]
struct GqlCommit {
    #[serde(rename = "statusCheckRollup")]
    status_check_rollup: Option<GqlRollup>,
}
#[derive(Deserialize)]
struct GqlRollup {
    state: String,
    contexts: GqlConn<GqlContext>,
}
/// A status-check context — either a `CheckRun` (GitHub Actions / apps) or a
/// legacy commit-status `StatusContext`, distinguished by `__typename`.
#[derive(Deserialize)]
struct GqlContext {
    #[serde(rename = "__typename")]
    typename: String,
    // CheckRun
    name: Option<String>,
    status: Option<String>,
    conclusion: Option<String>,
    #[serde(rename = "detailsUrl")]
    details_url: Option<String>,
    // StatusContext
    context: Option<String>,
    state: Option<String>,
    #[serde(rename = "targetUrl")]
    target_url: Option<String>,
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

/// Normalize one status-check context into a `StatusCheck`. A `CheckRun` carries
/// a two-part state (`status` + `conclusion`); a legacy `StatusContext` carries a
/// single `state`. Both collapse to SUCCESS | FAILURE | PENDING | NEUTRAL | ERROR.
fn normalize_check(c: GqlContext) -> StatusCheck {
    if c.typename == "CheckRun" {
        let state = match c.status.as_deref() {
            // Not COMPLETED yet → still running, regardless of conclusion.
            Some("COMPLETED") => match c.conclusion.as_deref() {
                Some("SUCCESS") => "SUCCESS",
                Some("NEUTRAL") | Some("SKIPPED") => "NEUTRAL",
                Some("FAILURE")
                | Some("TIMED_OUT")
                | Some("CANCELLED")
                | Some("STARTUP_FAILURE")
                | Some("STALE")
                | Some("ACTION_REQUIRED") => "FAILURE",
                _ => "PENDING",
            },
            _ => "PENDING",
        };
        StatusCheck {
            name: c.name.unwrap_or_else(|| "check".into()),
            state: state.into(),
            url: c.details_url,
        }
    } else {
        // StatusContext: state is a StatusState (EXPECTED | ERROR | FAILURE | PENDING | SUCCESS).
        let state = match c.state.as_deref() {
            Some("SUCCESS") => "SUCCESS",
            Some("FAILURE") => "FAILURE",
            Some("ERROR") => "ERROR",
            Some("EXPECTED") => "PENDING",
            _ => "PENDING",
        };
        StatusCheck {
            name: c.context.unwrap_or_else(|| "status".into()),
            state: state.into(),
            url: c.target_url,
        }
    }
}

/// Read-only PR sidebar metadata (reviewers + states, assignees, labels,
/// milestone, linked "closing" issues, and the roll-up merge requirements),
/// fetched in one GraphQL call.
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
        &graphql_url(&state),
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
                merge: MergeInfo {
                    review_decision: None,
                    mergeable: "UNKNOWN".into(),
                    merge_state_status: "UNKNOWN".into(),
                    is_draft: false,
                    check_rollup: None,
                    checks: vec![],
                },
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

    // Head-commit CI checks, normalized from the status-check rollup. A PR with
    // no commits/checks simply yields an empty list and a null rollup.
    let rollup = pr
        .commits
        .nodes
        .into_iter()
        .next()
        .and_then(|n| n.commit.status_check_rollup);
    let (check_rollup, checks) = match rollup {
        Some(r) => {
            let checks = r.contexts.nodes.into_iter().map(normalize_check).collect();
            (Some(r.state), checks)
        }
        None => (None, vec![]),
    };

    let merge = MergeInfo {
        review_decision: pr.review_decision,
        mergeable: pr.mergeable.unwrap_or_else(|| "UNKNOWN".into()),
        merge_state_status: pr.merge_state_status.unwrap_or_else(|| "UNKNOWN".into()),
        is_draft: pr.is_draft,
        check_rollup,
        checks,
    };

    Ok(PrDetails {
        reviewers,
        merge,
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
