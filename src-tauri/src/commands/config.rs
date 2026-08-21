//! Read the effective git config for a repo (every occurrence, source-annotated)
//! and edit a curated safe subset — identity, remote URLs, and branch upstreams —
//! always at **local** scope (#306). Never touches the developer's global/system
//! config, and every write is validated up front so a curated field can never
//! smuggle an arbitrary key into `.git/config`.
//!
//! `.git/config` is not watched by the filesystem watcher (`watch::is_interesting`
//! only follows `HEAD`/`refs`/`packed-refs`/`index`/`worktrees`), so the panel's
//! Refresh button is the only way its view picks up an external change — by
//! design, not an oversight.

use std::path::Path;

use git2::{BranchType, ConfigLevel};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git;
use crate::state::AppState;

// ---- Serializable types ----------------------------------------------------

/// One occurrence of a config key, from `Config::entries` — a lending iterator
/// that surfaces every value at every layer, not just the winner (#306's core
/// complaint: hiding the layer makes inherited values look local).
#[derive(Serialize)]
pub struct ConfigEntry {
    pub name: String,
    /// `None` for a non-UTF-8 value — the row still renders, just without a
    /// displayable value, rather than aborting the whole read.
    pub value: Option<String>,
    pub level: String,
    /// Whether this occurrence is the one git actually resolves to.
    pub effective: bool,
}

/// One identity field (`user.name` / `user.email`): the effective value plus the
/// level it resolves from, and the raw local-scope value so the editor can tell
/// "inherited from global" apart from "set here".
#[derive(Serialize)]
pub struct IdentityValue {
    pub value: Option<String>,
    pub level: Option<String>,
    pub local_value: Option<String>,
}

#[derive(Serialize)]
pub struct Identity {
    pub name: IdentityValue,
    pub email: IdentityValue,
}

/// A configured remote — name plus its **unredacted** URL. Unlike `entries[]`,
/// this is never redacted: the editor round-trips it, and redacting it would
/// mean saving an untouched field overwrites a credential-bearing URL with `***`.
#[derive(Serialize)]
pub struct RemoteRow {
    pub name: String,
    pub url: String,
    /// `remote.<name>.pushurl`, when the remote has a push URL distinct from
    /// its fetch URL. Disclosure only — the panel never writes this, so a
    /// remote's URL editor can't silently retarget where pushes actually go.
    pub push_url: Option<String>,
}

/// A local branch's current upstream wiring, read straight from
/// `branch.<name>.remote` / `branch.<name>.merge` rather than the resolved
/// remote-tracking ref, so a dangling upstream still shows what's configured.
#[derive(Serialize)]
pub struct BranchRow {
    pub name: String,
    pub remote: Option<String>,
    pub merge: Option<String>,
    pub is_head: bool,
    /// Commits on this branch not on its configured upstream, or `None` when
    /// there's no upstream configured or it doesn't resolve (e.g. dangling).
    pub ahead: Option<u32>,
    /// Commits on the upstream not on this branch, under the same `None` rule
    /// as `ahead`.
    pub behind: Option<u32>,
    /// Whether the branch tip is reachable from HEAD — i.e. merged into the
    /// branch currently checked out. `false` when HEAD is unborn.
    pub merged: bool,
    /// A protected branch (`pref.protectedBranches`, default main/master) or
    /// the currently checked-out branch — the same predicate
    /// `cleanup::is_protected` uses to decide `list_stale_branches`/
    /// `delete_branches` eligibility, so the Branches table's Delete button
    /// never offers a branch the backend would refuse anyway.
    pub protected: bool,
}

#[derive(Serialize)]
pub struct ConfigOverview {
    pub entries: Vec<ConfigEntry>,
    pub identity: Identity,
    pub remotes: Vec<RemoteRow>,
    pub branches: Vec<BranchRow>,
    /// Remote-tracking branch shorthand names (`origin/main`, …), to populate
    /// the upstream picker.
    pub remote_branches: Vec<String>,
}

/// Which identity key a curated write targets — a closed set, so no arbitrary
/// config key can reach the writer through this command.
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdentityField {
    Name,
    Email,
}

impl IdentityField {
    fn key(&self) -> &'static str {
        match self {
            IdentityField::Name => "user.name",
            IdentityField::Email => "user.email",
        }
    }
}

// ---- Level mapping + redaction (pure, unit-tested) -------------------------

/// Map every one of git2's seven real `ConfigLevel` variants to a stable,
/// user-facing label. `Highest` is a sentinel some other APIs accept as an
/// argument (never a level `entries()`/`get_entry()` actually reports), but is
/// matched explicitly rather than falling through a wildcard so an exhaustive
/// match keeps this honest if git2 ever adds a real level.
fn level_label(level: ConfigLevel) -> &'static str {
    match level {
        ConfigLevel::ProgramData | ConfigLevel::System => "system",
        ConfigLevel::XDG => "global (xdg)",
        ConfigLevel::Global => "global",
        ConfigLevel::Local => "local",
        ConfigLevel::Worktree => "worktree",
        ConfigLevel::App => "app",
        ConfigLevel::Highest => "app",
    }
}

/// Redact a config entry headed for the bulk-exposure table: strip URL userinfo
/// (`https://user:token@host/x` → `https://***@host/x`) from the value **and**
/// the key name (a key can itself embed a credential-bearing URL, e.g.
/// `url.<https URL with userinfo>.insteadOf`), fully mask values of keys that
/// carry credentials outright (`*.extraheader`, anything with `password`/`token`
/// in its name), and fully mask values that merely *look* like a credential
/// regardless of what key they're stored under (`password=`, a GitHub token
/// prefix, an `Authorization:` header — e.g. `credential.helper`'s output).
/// This is a best-effort heuristic, not an exhaustive credential scanner.
/// Applied only to `entries[]`; `remotes[].url` is never redacted (see
/// `RemoteRow`).
fn redact_value(name: &str, value: &str) -> String {
    let lname = name.to_lowercase();
    if lname.ends_with(".extraheader")
        || lname.contains("password")
        || lname.contains("token")
        || looks_like_credential_value(value)
    {
        return "***".to_string();
    }
    redact_url_userinfo(value).unwrap_or_else(|| value.to_string())
}

/// Mask a config entry's key name the same way `redact_value` masks its value
/// — a key can itself carry a credential-bearing URL (`url.<URL>.insteadOf`),
/// which `redact_value` never sees since it only ever looks at the value.
fn redact_name(name: &str) -> String {
    redact_url_userinfo(name).unwrap_or_else(|| name.to_string())
}

/// Value-shaped credential heuristics that a key-name check alone misses —
/// e.g. `credential.helper`'s output embeds a password without "password" or
/// "token" being part of the *key* at all.
fn looks_like_credential_value(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.contains("password=")
        || lower.contains("ghp_")
        || lower.contains("github_pat_")
        || lower.contains("authorization:")
}

/// Replace `scheme://user:pass@host/...` with `scheme://***@host/...`. Returns
/// `None` when `value` doesn't look like a URL with userinfo — including a bare
/// username with no `:` (e.g. `ssh://git@host/x.git`), which carries no secret
/// and is left readable — so the caller falls back to the original value
/// unchanged.
fn redact_url_userinfo(value: &str) -> Option<String> {
    let scheme_end = value.find("://")?;
    let (scheme, rest) = value.split_at(scheme_end);
    let after_scheme = &rest[3..];
    let slash_pos = after_scheme.find('/').unwrap_or(after_scheme.len());
    // The LAST `@` before the path, not the first: a password containing `@`
    // (`user:p@ss@host`) would otherwise split inside the password, leaking
    // everything after its first `@`.
    let at_pos = after_scheme[..slash_pos].rfind('@')?;
    if at_pos == 0 {
        return None;
    }
    let userinfo = &after_scheme[..at_pos];
    if !userinfo.contains(':') {
        return None;
    }
    Some(format!("{scheme}://***@{}", &after_scheme[at_pos + 1..]))
}

/// Guard every curated write: no newline/CR, no `[`/`]`/`"`/`\`, and no
/// leading/trailing whitespace — the characters that would let a value smuggle
/// a new section/key into `.git/config` (config-injection) or silently corrupt
/// the stored value.
fn validate_config_value(value: &str) -> AppResult<()> {
    if value.trim() != value {
        return Err(AppError::Other(
            "value cannot have leading or trailing whitespace".to_string(),
        ));
    }
    for bad in ['\n', '\r', '[', ']', '"', '\\'] {
        if value.contains(bad) {
            return Err(AppError::Other(format!("value cannot contain '{bad}'")));
        }
    }
    Ok(())
}

// ---- Read -------------------------------------------------------------------

/// Effective git config for a repo — every occurrence, source-annotated — plus
/// identity, remotes, and branch-upstream wiring for the curated editors.
/// `read_branches` runs two revwalks per local branch (ahead/behind, then
/// merged), so — unlike a plain config read — this is not cheap on a repo with
/// many local branches. It goes through the gated `run_git_gated` (the same
/// cap the git-status scans use, #89) rather than `run_git_blocking`, so a
/// burst of refreshes across branch-heavy repos can't stampede.
#[tauri::command]
pub async fn git_config_overview(
    state: State<'_, AppState>,
    repo_id: i64,
) -> AppResult<ConfigOverview> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    // Resolved up front (needs the DB connection) so the blocking closure below
    // only needs an already-open repo handle, same as every other gated read.
    let protected = crate::commands::cleanup::protected_branches(&state);
    crate::commands::run_git_gated(&state, move || {
        let repo = git::open(&path)?;
        build_overview(&repo, &protected)
    })
    .await
}

fn build_overview(repo: &git2::Repository, protected: &[String]) -> AppResult<ConfigOverview> {
    let config = repo.config()?;
    let entries = read_entries(&config)?;
    let identity = Identity {
        name: read_identity_field(&config, IdentityField::Name.key())?,
        email: read_identity_field(&config, IdentityField::Email.key())?,
    };
    let remotes = read_remotes(repo)?;
    let remote_branches = remote_tracking_names(repo)?;
    let branches = read_branches(repo, &config, protected)?;
    Ok(ConfigOverview {
        entries,
        identity,
        remotes,
        branches,
        remote_branches,
    })
}

/// Read every occurrence of every key, marking exactly one occurrence per name
/// as `effective` — the one `Config::get_entry` resolves to. A genuine multivar
/// key (multiple values at one level, e.g. `remote.origin.fetch`) does *not*
/// make `get_entry` ambiguous: it returns `Ok` with the LAST value written,
/// mirroring how git itself resolves a multivar, so that last occurrence is
/// marked effective exactly like any other key — every value still gets a row,
/// but one of them is singled out as "the" value, same as any non-multivar key.
fn read_entries(config: &git2::Config) -> AppResult<Vec<ConfigEntry>> {
    let mut raw: Vec<(String, Option<String>, ConfigLevel)> = Vec::new();
    config
        .entries(None)?
        .for_each(|entry| {
            if let Some(name) = entry.name() {
                raw.push((
                    name.to_string(),
                    entry.value().map(|v| v.to_string()),
                    entry.level(),
                ));
            }
        })
        .map_err(AppError::from)?;

    let mut effective = vec![false; raw.len()];
    let mut seen = std::collections::HashSet::new();
    for i in 0..raw.len() {
        let name = raw[i].0.clone();
        if !seen.insert(name.clone()) {
            continue;
        }
        if let Ok(winner) = config.get_entry(&name) {
            let want_level = winner.level();
            let want_value = winner.value().map(|v| v.to_string());
            if let Some(idx) = raw
                .iter()
                .position(|(n, v, l)| *n == name && *l == want_level && *v == want_value)
            {
                effective[idx] = true;
            }
        }
    }

    Ok(raw
        .into_iter()
        .zip(effective)
        .map(|((name, value, level), effective)| {
            let masked_value = value.map(|v| redact_value(&name, &v));
            ConfigEntry {
                value: masked_value,
                name: redact_name(&name),
                level: level_label(level).to_string(),
                effective,
            }
        })
        .collect())
}

/// Not-found is "unset", not an error, for every read helper below.
fn ok_or_unset<T>(r: Result<T, git2::Error>) -> AppResult<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.code() == git2::ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn read_identity_field(config: &git2::Config, key: &str) -> AppResult<IdentityValue> {
    let entry = ok_or_unset(config.get_entry(key))?;
    let (value, level) = match entry {
        Some(e) => (
            e.value().map(|v| v.to_string()),
            Some(level_label(e.level()).to_string()),
        ),
        None => (None, None),
    };
    // Reuse the caller's already-resolved config handle rather than resolving
    // the whole stack again from the repo just to peel off its Local level.
    let local = config.open_level(ConfigLevel::Local)?;
    let local_value = ok_or_unset(local.get_string(key))?;
    Ok(IdentityValue {
        value,
        level,
        local_value,
    })
}

fn read_remotes(repo: &git2::Repository) -> AppResult<Vec<RemoteRow>> {
    let mut out = Vec::new();
    for name in repo.remotes()?.iter().flatten() {
        if let Ok(remote) = repo.find_remote(name) {
            if let Some(url) = remote.url() {
                out.push(RemoteRow {
                    name: name.to_string(),
                    url: url.to_string(),
                    push_url: remote.pushurl().map(|u| u.to_string()),
                });
            }
        }
    }
    Ok(out)
}

fn read_branches(
    repo: &git2::Repository,
    config: &git2::Config,
    protected: &[String],
) -> AppResult<Vec<BranchRow>> {
    // HEAD's commit, used to decide `merged` for every branch — resolved once
    // rather than per-row. `None` when HEAD is unborn (fresh repo, no commits).
    let head_oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());
    let current = git::current_branch(repo);

    let mut out = Vec::new();
    for b in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = b?;
        let Some(name) = branch.name()? else {
            continue;
        };
        let remote = ok_or_unset(config.get_string(&format!("branch.{name}.remote")))?;
        let merge = ok_or_unset(config.get_string(&format!("branch.{name}.merge")))?;
        let (ahead, behind) = branch_ahead_behind(repo, &branch);
        // Short-circuit: 0 ahead of its upstream means every commit on this
        // branch already lives on the upstream, which is exactly what
        // `branch_is_merged`'s upstream check (below) would conclude anyway —
        // skip the revwalk entirely rather than paying for it a second time.
        // Only valid when `ahead` actually resolved (`Some`); `None` (no
        // upstream, or it doesn't resolve) falls through to the real check.
        let merged = ahead == Some(0) || branch_is_merged(repo, &branch, head_oid);
        out.push(BranchRow {
            protected: crate::commands::cleanup::is_protected(name, current.as_deref(), protected),
            name: name.to_string(),
            remote,
            merge,
            is_head: branch.is_head(),
            ahead,
            behind,
            merged,
        });
    }
    Ok(out)
}

/// A branch's ahead/behind vs. its configured upstream (resolved the same way
/// `Branch::upstream` always has — including a `remote = "."` local-tracking
/// upstream, not just a `refs/remotes/...` one). `None` for either count when
/// there's no upstream configured, it doesn't resolve, or either tip is
/// unborn — never a fabricated `0`, which would read as "up to date" for a
/// branch that has no real upstream to compare against.
fn branch_ahead_behind(
    repo: &git2::Repository,
    branch: &git2::Branch,
) -> (Option<u32>, Option<u32>) {
    let Some(local_oid) = branch.get().target() else {
        return (None, None);
    };
    let Ok(upstream) = branch.upstream() else {
        return (None, None);
    };
    let Some(upstream_oid) = upstream.get().target() else {
        return (None, None);
    };
    match repo.graph_ahead_behind(local_oid, upstream_oid) {
        Ok((ahead, behind)) => (Some(ahead as u32), Some(behind as u32)),
        Err(_) => (None, None),
    }
}

/// Whether `branch`'s tip is reachable from `head_oid` (merged into the branch
/// currently checked out) OR from its own configured upstream's tip — mirrors
/// `git branch -d`, which permits deleting a branch merged into either. The
/// tip being identical to the target counts as merged in both cases (nothing
/// to lose by "deleting" the current state of that same commit);
/// `graph_descendant_of` alone doesn't cover that identical-commit case.
pub(crate) fn branch_is_merged(
    repo: &git2::Repository,
    branch: &git2::Branch,
    head_oid: Option<git2::Oid>,
) -> bool {
    let Some(tip) = branch.get().target() else {
        return false;
    };
    if let Some(head_oid) = head_oid {
        if tip == head_oid || repo.graph_descendant_of(head_oid, tip).unwrap_or(false) {
            return true;
        }
    }
    if let Ok(upstream) = branch.upstream() {
        if let Some(upstream_oid) = upstream.get().target() {
            if tip == upstream_oid || repo.graph_descendant_of(upstream_oid, tip).unwrap_or(false) {
                return true;
            }
        }
    }
    false
}

/// A remote-tracking branch's shorthand (`origin/main`) whose last path segment
/// is `HEAD` (`origin/HEAD`) — the symbolic pointer to the remote's default
/// branch, not a branch of its own. Mirrors the same rule `repo::checkout_at`
/// already applies (`resolve_head_target`), so `origin/HEAD` is never something
/// this picker offers or `set_branch_upstream_at` accepts as an upstream: it
/// would resolve to `branch.<n>.merge = refs/heads/HEAD`, a ref that doesn't
/// exist as a real branch, defeating every feature that trusts
/// `branch.<n>.remote`/`.merge` (see the doc comment on
/// `git_config_set_branch_upstream`).
fn shorthand_is_head(name: &str) -> bool {
    name.rsplit('/').next() == Some("HEAD")
}

fn remote_tracking_names(repo: &git2::Repository) -> AppResult<Vec<String>> {
    let mut out = Vec::new();
    for b in repo.branches(Some(BranchType::Remote))? {
        let (branch, _) = b?;
        if let Some(name) = branch.name()? {
            if shorthand_is_head(name) {
                continue;
            }
            out.push(name.to_string());
        }
    }
    Ok(out)
}

// ---- Write — local scope only, validated before any write ------------------

/// Set or clear `user.name`/`user.email` at local scope. `Some(v)` (non-blank
/// after trimming) validates and writes `v`; `None` or a blank value removes the
/// local key instead of writing an empty string, so the inherited value (global
/// or higher) takes over — clearing a field with no local value is a no-op.
#[tauri::command]
pub async fn git_config_set_identity(
    state: State<'_, AppState>,
    repo_id: i64,
    field: IdentityField,
    value: Option<String>,
) -> AppResult<()> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| set_identity_at(p, field, value)).await
}

fn set_identity_at(path: &Path, field: IdentityField, value: Option<String>) -> AppResult<()> {
    let repo = git::open(path)?;
    let mut local = repo.config()?.open_level(ConfigLevel::Local)?;
    write_or_clear_local(&mut local, field.key(), value)
}

/// Whether a `git2::Error` is libgit2 refusing `set_str`/`remove`/`get_string`
/// because the key is a multivar (multiple values already at that level) — an
/// ambiguity error, not a real failure, so callers fall back to the `*_multivar`
/// form instead of surfacing a raw libgit2 message with no way to recover.
/// Matched on the error text (libgit2 has no dedicated error code for this —
/// it's `ErrorCode::GenericError`, shared with unrelated failures) rather than
/// assuming a code.
fn is_multivar_ambiguous(e: &git2::Error) -> bool {
    e.message().contains("multivar")
}

/// Shared write-or-clear core for a single-valued local key: a non-blank value
/// (after trimming) is validated then `set_str`'d; blank/`None` removes the key,
/// tolerating "already absent". Either path falls back to the `*_multivar` form
/// when the key already has more than one value at local scope (`set_str`/
/// `remove` refuse an ambiguous multivar outright), collapsing it down to the
/// single value the panel is trying to save, or removing every occurrence.
fn write_or_clear_local(
    local: &mut git2::Config,
    key: &str,
    value: Option<String>,
) -> AppResult<()> {
    match value {
        Some(v) if !v.trim().is_empty() => {
            validate_config_value(&v)?;
            match local.set_str(key, &v) {
                Ok(()) => {}
                Err(e) if is_multivar_ambiguous(&e) => {
                    local.set_multivar(key, ".*", &v)?;
                }
                Err(e) => return Err(e.into()),
            }
        }
        _ => match local.remove(key) {
            Ok(()) => {}
            Err(e) if e.code() == git2::ErrorCode::NotFound => {}
            Err(e) if is_multivar_ambiguous(&e) => {
                local.remove_multivar(key, ".*")?;
            }
            Err(e) => return Err(e.into()),
        },
    }
    Ok(())
}

/// Set a remote's URL at local scope. Rejects a blank URL and an unconfigured
/// remote before writing anything. When the remote is `origin`, drops the
/// cached owner/repo slug (#136 / #306 impact hazard 1) so the next GitHub call
/// re-resolves against the new URL instead of hitting the old repository for
/// the rest of the process lifetime.
#[tauri::command]
pub async fn git_config_set_remote_url(
    state: State<'_, AppState>,
    repo_id: i64,
    remote: String,
    url: String,
) -> AppResult<()> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    let remote_for_write = remote.clone();
    crate::commands::run_git_blocking(path, move |p| set_remote_url_at(p, &remote_for_write, &url))
        .await?;
    if should_invalidate_origin_slug(&remote) {
        crate::commands::repo::invalidate_origin_slug(&state, repo_id);
    }
    Ok(())
}

/// Whether writing `remote`'s URL should drop the cached owner/repo slug.
/// Extracted from `git_config_set_remote_url` into its own pure function so a
/// test can call the actual decision the command makes, rather than only
/// reproducing "only `origin` matters" by hand — which would keep passing even
/// if the production `if` were deleted.
fn should_invalidate_origin_slug(remote: &str) -> bool {
    remote == "origin"
}

fn set_remote_url_at(path: &Path, remote: &str, url: &str) -> AppResult<()> {
    if url.trim().is_empty() {
        return Err(AppError::Other("remote URL cannot be blank".to_string()));
    }
    validate_config_value(url)?;
    // git's `ext::` transport runs an arbitrary shell command on every
    // fetch/push. This app auto-fetches in the background on a timer, so a
    // pasted `ext::` URL would execute with no further user action (#299).
    if url.to_lowercase().starts_with("ext::") {
        return Err(AppError::Other(
            "remote URL cannot use the 'ext::' transport".to_string(),
        ));
    }
    let repo = git::open(path)?;
    repo.find_remote(remote)
        .map_err(|_| AppError::Other(format!("remote '{remote}' is not configured")))?;
    repo.remote_set_url(remote, url)?;
    Ok(())
}

/// Set or clear a local branch's upstream. `Some(upstream)` must name an
/// existing remote-tracking branch (`origin/main`) — the panel never pushes, so
/// an upstream that doesn't resolve would immediately mislead three shipped
/// features that read `branch.<n>.remote`/`.merge`: the publish-confirmation
/// gate (`sync::branch_needing_upstream`), auto-pull eligibility, and
/// `cleanup::upstream_is_gone`'s stale-branch listing (#306 impact hazard 2).
/// `None` clears both keys via `Branch::set_upstream(None)`.
#[tauri::command]
pub async fn git_config_set_branch_upstream(
    state: State<'_, AppState>,
    repo_id: i64,
    branch: String,
    upstream: Option<String>,
) -> AppResult<()> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        set_branch_upstream_at(p, &branch, upstream.as_deref())
    })
    .await
}

fn set_branch_upstream_at(path: &Path, branch: &str, upstream: Option<&str>) -> AppResult<()> {
    let repo = git::open(path)?;
    let mut local = repo.find_branch(branch, BranchType::Local)?;
    match upstream {
        Some(u) => {
            let known = remote_tracking_names(&repo)?;
            if !known.iter().any(|n| n == u) {
                return Err(AppError::Other(format!(
                    "'{u}' is not a known remote-tracking branch"
                )));
            }
            local.set_upstream(Some(u))?;
        }
        None => local.set_upstream(None)?,
    }
    Ok(())
}

// ---- Tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::sync::Mutex;

    // `git2::opts::set_search_path` is process-global and not thread-safe, and
    // Rust runs `#[test]` fns in parallel by default. Every test in this module
    // that touches global/system search paths locks this first, serializing
    // them so one test's isolated paths can never leak into another's.
    static CONFIG_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_repo(name: &str) -> (std::path::PathBuf, Repository) {
        let root =
            std::env::temp_dir().join(format!("gamut_config_test_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        (root, repo)
    }

    /// Build a new commit on top of `parent_oid`, writing `name` = `contents`,
    /// without touching the index, HEAD, or working tree — used to create a
    /// commit on a branch other than the one currently checked out (mirrors the
    /// helper of the same name in `commands::repo`'s test module).
    fn commit_on(
        repo: &Repository,
        parent_oid: git2::Oid,
        name: &str,
        contents: &str,
    ) -> git2::Oid {
        let parent = repo.find_commit(parent_oid).unwrap();
        let parent_tree = parent.tree().unwrap();
        let mut builder = repo.treebuilder(Some(&parent_tree)).unwrap();
        let blob_oid = repo.blob(contents.as_bytes()).unwrap();
        builder.insert(name, blob_oid, 0o100644).unwrap();
        let tree_oid = builder.write().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        repo.commit(None, &sig, &sig, "msg", &tree, &[&parent])
            .unwrap()
    }

    fn commit_file(repo: &Repository, name: &str, contents: &str) {
        let wd = repo.workdir().unwrap();
        std::fs::write(wd.join(name), contents).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .into_iter()
            .collect();
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, "msg", &tree, &parent_refs)
            .unwrap();
    }

    /// RAII guard that restores the process-global git2 search paths (Global/
    /// System/XDG) to whatever they were before `isolate_search_paths` pointed
    /// them at a test's isolated temp dirs. Without this, the isolated paths
    /// stay installed for the rest of the test binary's process lifetime —
    /// latent nondeterminism for every other git2 test that runs afterward.
    /// Held alongside `CONFIG_TEST_LOCK`'s guard for the same reason: both are
    /// process-global state that must be undone before the next test (in this
    /// module or, since search paths are process-wide, any other) can trust a
    /// clean starting point.
    struct SearchPathGuard {
        global: std::ffi::CString,
        system: std::ffi::CString,
        xdg: std::ffi::CString,
    }

    impl Drop for SearchPathGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = git2::opts::set_search_path(ConfigLevel::Global, &self.global);
                let _ = git2::opts::set_search_path(ConfigLevel::System, &self.system);
                let _ = git2::opts::set_search_path(ConfigLevel::XDG, &self.xdg);
            }
        }
    }

    /// Point global/system/XDG search paths at fresh empty temp dirs, so no test
    /// here ever reads the developer's real `~/.gitconfig` (A20). Returns a
    /// guard that puts the prior paths back on drop — callers must bind it
    /// (`let _search_guard = isolate_search_paths(tag);`) so it lives for the
    /// rest of the test rather than being dropped (and restoring) immediately.
    #[must_use]
    fn isolate_search_paths(tag: &str) -> SearchPathGuard {
        let guard = unsafe {
            SearchPathGuard {
                global: git2::opts::get_search_path(ConfigLevel::Global).unwrap(),
                system: git2::opts::get_search_path(ConfigLevel::System).unwrap(),
                xdg: git2::opts::get_search_path(ConfigLevel::XDG).unwrap(),
            }
        };

        let base = std::env::temp_dir().join(format!(
            "gamut_config_test_search_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        let global = base.join("global");
        let system = base.join("system");
        let xdg = base.join("xdg");
        std::fs::create_dir_all(&global).unwrap();
        std::fs::create_dir_all(&system).unwrap();
        std::fs::create_dir_all(&xdg).unwrap();
        unsafe {
            git2::opts::set_search_path(ConfigLevel::Global, &global).unwrap();
            git2::opts::set_search_path(ConfigLevel::System, &system).unwrap();
            git2::opts::set_search_path(ConfigLevel::XDG, &xdg).unwrap();
        }

        guard
    }

    /// Write a key at the isolated global level via the repo's own resolved
    /// config (rather than guessing the on-disk filename libgit2 picks for a
    /// custom search-path directory) — guaranteed to land where `repo.config()`
    /// will actually read it back from.
    fn set_global(repo: &Repository, key: &str, value: &str) {
        let mut global = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Global)
            .unwrap();
        global.set_str(key, value).unwrap();
    }

    /// Count the entries at a single config level, via the repo's own resolved
    /// config — same rationale as `set_global`.
    fn count_at_level(repo: &Repository, level: ConfigLevel) -> usize {
        let cfg = repo.config().unwrap().open_level(level).unwrap();
        let mut n = 0;
        cfg.entries(None).unwrap().for_each(|_| n += 1).unwrap();
        n
    }

    /// The set of level labels (`level_label` strings) present anywhere in the
    /// repo's merged config — used to prove a level with no on-disk file (e.g.
    /// an unseeded isolated system level) never gains an entry.
    fn levels_present(repo: &Repository) -> std::collections::HashSet<String> {
        let config = repo.config().unwrap();
        read_entries(&config)
            .unwrap()
            .into_iter()
            .map(|e| e.level)
            .collect()
    }

    // ---- A2: level_label covers all seven variants ----

    #[test]
    fn level_label_covers_every_variant() {
        assert_eq!(level_label(ConfigLevel::ProgramData), "system");
        assert_eq!(level_label(ConfigLevel::System), "system");
        assert_eq!(level_label(ConfigLevel::XDG), "global (xdg)");
        assert_eq!(level_label(ConfigLevel::Global), "global");
        assert_eq!(level_label(ConfigLevel::Local), "local");
        assert_eq!(level_label(ConfigLevel::Worktree), "worktree");
        assert_eq!(level_label(ConfigLevel::App), "app");
    }

    // ---- A5: redaction ----

    #[test]
    fn redact_value_strips_url_userinfo_and_masks_credential_keys() {
        assert_eq!(
            redact_value("remote.origin.url", "https://user:tok@host/x.git"),
            "https://***@host/x.git"
        );
        assert_eq!(
            redact_value(
                "http.https://example.com/.extraheader",
                "Authorization: Basic xyz"
            ),
            "***"
        );
        assert_eq!(redact_value("some.password", "hunter2"), "***");
        assert_eq!(redact_value("some.token", "abc123"), "***");
        // Unrelated values pass through untouched.
        assert_eq!(redact_value("user.name", "Jane Doe"), "Jane Doe");
        assert_eq!(
            redact_value("remote.origin.url", "https://host/x.git"),
            "https://host/x.git"
        );
    }

    // ---- fix 10: redaction gaps — value-shaped credentials, and the Key column ----

    #[test]
    fn redact_value_masks_a_credential_shaped_value_even_under_an_unrelated_key() {
        // `credential.helper`'s key name carries no "password"/"token" hint —
        // only the *value* it prints gives away that it embeds a credential.
        assert_eq!(
            redact_value(
                "credential.helper",
                "!f() { echo password=ghp_SECRETTOKEN; }; f"
            ),
            "***"
        );
    }

    #[test]
    fn redact_name_masks_userinfo_embedded_in_a_key() {
        // The token lives in the KEY here (`url.<URL>.insteadOf`), which
        // `redact_value` never inspects — the Key column must be redacted too.
        assert_eq!(
            redact_name("url.https://x-access-token:ghp_SECRET@github.com/.insteadOf"),
            "url.https://***@github.com/.insteadOf"
        );
    }

    // ---- fix 11 / 12: redact_url_userinfo edge cases ----

    #[test]
    fn redact_url_userinfo_uses_the_last_at_before_the_path() {
        // A password containing `@` must not leak everything after its FIRST
        // `@` — splitting there would render `https://***@ss@host/x.git`.
        assert_eq!(
            redact_value("remote.origin.url", "https://user:p@ss@host/x.git"),
            "https://***@host/x.git"
        );
    }

    #[test]
    fn redact_url_userinfo_leaves_a_bare_ssh_username_unmasked() {
        assert_eq!(
            redact_value("remote.origin.url", "ssh://git@host/x.git"),
            "ssh://git@host/x.git",
            "a bare username with no `:` carries no secret and should stay readable"
        );
        assert_eq!(
            redact_value("remote.origin.url", "https://u:tok@host/x.git"),
            "https://***@host/x.git",
            "an actual password component (a `:` in the userinfo) is still masked"
        );
    }

    // ---- A13: validate_config_value ----

    #[test]
    fn validate_config_value_rejects_injection_and_whitespace() {
        assert!(validate_config_value("a@b\n[core]\n\tbare = true").is_err());
        assert!(validate_config_value("a\rb").is_err());
        assert!(validate_config_value("a[b").is_err());
        assert!(validate_config_value("a]b").is_err());
        assert!(validate_config_value("a\"b").is_err());
        assert!(validate_config_value("a\\b").is_err());
        assert!(validate_config_value(" a").is_err());
        assert!(validate_config_value("a ").is_err());
        assert!(validate_config_value("a@b.com").is_ok());
    }

    // ---- A3 / A4: entries — one row per occurrence, effective flag ----

    #[test]
    fn entries_mark_exactly_one_occurrence_effective_across_layers() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "effective";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        // Set at isolated global...
        set_global(&repo, "user.email", "global@example.com");

        // ...and at local, with a different value.
        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local.set_str("user.email", "local@example.com").unwrap();
        }

        let config = repo.config().unwrap();
        let entries = read_entries(&config).unwrap();
        let email_rows: Vec<&ConfigEntry> =
            entries.iter().filter(|e| e.name == "user.email").collect();
        assert_eq!(email_rows.len(), 2, "one row per occurrence");
        let effective: Vec<&&ConfigEntry> = email_rows.iter().filter(|e| e.effective).collect();
        assert_eq!(effective.len(), 1, "exactly one marked effective");
        assert_eq!(effective[0].value.as_deref(), Some("local@example.com"));
        assert_eq!(effective[0].level, "local");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn entries_keeps_both_multivar_values_at_one_level() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "multivar";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/x.git").unwrap();

        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local
                .set_multivar(
                    "remote.origin.fetch",
                    "^$",
                    "+refs/heads/a:refs/remotes/origin/a",
                )
                .unwrap();
            local
                .set_multivar(
                    "remote.origin.fetch",
                    "refs/heads/a:refs/remotes/origin/a",
                    "+refs/heads/b:refs/remotes/origin/b",
                )
                .unwrap();
        }

        let config = repo.config().unwrap();
        let entries = read_entries(&config).unwrap();
        let fetch_rows: Vec<&ConfigEntry> = entries
            .iter()
            .filter(|e| e.name == "remote.origin.fetch")
            .collect();
        assert_eq!(fetch_rows.len(), 2, "neither multivar value is dropped");

        // `Config::get_entry` on a multivar is NOT ambiguous — it resolves to
        // the LAST value written, the same way git itself does — so exactly
        // one row is marked effective, and it carries that last value.
        let effective: Vec<&&ConfigEntry> = fetch_rows.iter().filter(|e| e.effective).collect();
        assert_eq!(
            effective.len(),
            1,
            "the last multivar value is marked effective, same as any other key"
        );
        assert_eq!(
            effective[0].value.as_deref(),
            Some("+refs/heads/b:refs/remotes/origin/b"),
            "the LAST value written is the one git (and get_entry) resolves to"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A6: non-UTF-8 value ----

    #[test]
    fn non_utf8_value_does_not_abort_the_read() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "nonutf8";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        // Write a raw non-UTF-8 byte sequence directly into the local config file
        // (git2's own `set_str` requires valid UTF-8, so this bypasses it).
        let config_path = repo.path().join("config");
        let mut bytes = std::fs::read(&config_path).unwrap();
        bytes.extend_from_slice(b"[weird]\n\tval = \xff\xfe\n");
        std::fs::write(&config_path, bytes).unwrap();

        let config = repo.config().unwrap();
        let entries = read_entries(&config).unwrap();
        let weird = entries.iter().find(|e| e.name == "weird.val").unwrap();
        assert_eq!(weird.value, None, "non-UTF-8 value reads as None");
        // Other entries still render (repo has at least core.bare from `init`).
        assert!(entries.iter().any(|e| e.name == "core.bare"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A8: Refresh re-reads from disk ----

    #[test]
    fn a_second_read_reflects_an_externally_written_key() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "refresh";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        let config = repo.config().unwrap();
        assert!(!read_entries(&config)
            .unwrap()
            .iter()
            .any(|e| e.name == "user.name"));

        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local.set_str("user.name", "External Writer").unwrap();
        }

        let config = repo.config().unwrap();
        let entries = read_entries(&config).unwrap();
        let row = entries.iter().find(|e| e.name == "user.name").unwrap();
        assert_eq!(row.value.as_deref(), Some("External Writer"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A11 / A12: identity set + clear ----

    #[test]
    fn set_identity_stores_exact_value_once_and_replaces_on_resave() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "identity_set";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        set_identity_at(&root, IdentityField::Name, Some("First Name".to_string())).unwrap();
        set_identity_at(&root, IdentityField::Name, Some("Second Name".to_string())).unwrap();

        let local = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        assert_eq!(local.get_string("user.name").unwrap(), "Second Name");

        let mut count = 0;
        local
            .entries(Some("user.name"))
            .unwrap()
            .for_each(|_| count += 1)
            .unwrap();
        assert_eq!(
            count, 1,
            "stored exactly once, never appended as a multivar"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn clear_identity_removes_local_key_and_falls_back_to_global() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "identity_clear";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        set_global(&repo, "user.email", "global@example.com");

        set_identity_at(
            &root,
            IdentityField::Email,
            Some("local@example.com".to_string()),
        )
        .unwrap();
        set_identity_at(&root, IdentityField::Email, None).unwrap();

        let local = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        assert!(matches!(
            local.get_string("user.email"),
            Err(e) if e.code() == git2::ErrorCode::NotFound
        ));
        let effective = repo.config().unwrap();
        assert_eq!(
            effective.get_string("user.email").unwrap(),
            "global@example.com"
        );

        // A second clear (nothing local to remove) is still Ok.
        assert!(set_identity_at(&root, IdentityField::Email, None).is_ok());

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A13: rejects config-injection payloads, writes nothing ----

    #[test]
    fn identity_write_rejects_injection_payload() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "identity_injection";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        set_identity_at(&root, IdentityField::Email, Some("a@b.com".to_string())).unwrap();
        // `git init` already writes `core.bare = false` — capture it so the
        // assertion below proves the injected `[core]\n\tbare = true` payload
        // never took effect, rather than assuming the key starts absent.
        let bare_before = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap()
            .get_bool("core.bare")
            .unwrap();

        let result = set_identity_at(
            &root,
            IdentityField::Email,
            Some("a@b\n[core]\n\tbare = true".to_string()),
        );
        assert!(result.is_err());

        let local = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        assert_eq!(
            local.get_string("user.email").unwrap(),
            "a@b.com",
            "unchanged"
        );
        assert_eq!(
            local.get_bool("core.bare").unwrap(),
            bare_before,
            "injected [core] bare=true never took effect"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- fix 4: a multivar local key must not break Save/Clear ----

    #[test]
    fn saving_over_a_local_multivar_key_collapses_it_to_one_value() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "identity_multivar_save";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        // Seed `user.name` as a local multivar (two occurrences) — something
        // `set_identity_at` itself would never write, but an external tool or a
        // hand-edited `.git/config` can.
        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local.set_multivar("user.name", "^$", "First").unwrap();
            local.set_multivar("user.name", "First", "Second").unwrap();
        }

        set_identity_at(&root, IdentityField::Name, Some("Collapsed".to_string())).unwrap();

        let local = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        let mut values = Vec::new();
        local
            .entries(Some("user.name"))
            .unwrap()
            .for_each(|e| values.push(e.value().map(str::to_string)))
            .unwrap();
        assert_eq!(
            values,
            vec![Some("Collapsed".to_string())],
            "exactly one occurrence, holding the newly-saved value"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn clearing_a_local_multivar_key_removes_every_occurrence() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "identity_multivar_clear";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local.set_multivar("user.name", "^$", "First").unwrap();
            local.set_multivar("user.name", "First", "Second").unwrap();
        }

        set_identity_at(&root, IdentityField::Name, None).unwrap();

        let local = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        assert!(matches!(
            local.get_string("user.name"),
            Err(e) if e.code() == git2::ErrorCode::NotFound
        ));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A14 / A15 / A16: remote URL writes ----

    #[test]
    fn set_remote_url_stores_exact_value_and_leaves_other_remotes_untouched() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "remote_url";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/orig.git")
            .unwrap();
        repo.remote("upstream", "https://example.com/upstream.git")
            .unwrap();

        set_remote_url_at(&root, "origin", "https://example.com/new.git").unwrap();

        let repo2 = Repository::open(&root).unwrap();
        assert_eq!(
            repo2.find_remote("origin").unwrap().url().unwrap(),
            "https://example.com/new.git"
        );
        assert_eq!(
            repo2.find_remote("upstream").unwrap().url().unwrap(),
            "https://example.com/upstream.git"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resaving_the_untouched_url_round_trips_byte_identically() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "remote_url_roundtrip";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        let original = "https://user:tok@example.com/x.git";
        repo.remote("origin", original).unwrap();

        // The value the overview would have returned (unredacted) is re-saved
        // verbatim — simulating "save an untouched field".
        set_remote_url_at(&root, "origin", original).unwrap();

        let repo2 = Repository::open(&root).unwrap();
        assert_eq!(
            repo2.find_remote("origin").unwrap().url().unwrap(),
            original
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn blank_url_and_unknown_remote_are_rejected() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "remote_url_reject";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/orig.git")
            .unwrap();

        assert!(set_remote_url_at(&root, "origin", "   ").is_err());
        assert!(set_remote_url_at(&root, "does-not-exist", "https://example.com/x.git").is_err());

        let repo2 = Repository::open(&root).unwrap();
        assert_eq!(
            repo2.find_remote("origin").unwrap().url().unwrap(),
            "https://example.com/orig.git",
            "unchanged"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- fix 13: the `ext::` remote transport must be rejected ----

    #[test]
    fn rejects_the_ext_transport_and_writes_nothing() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "remote_url_ext_reject";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/orig.git")
            .unwrap();

        assert!(set_remote_url_at(&root, "origin", "ext::sh -c 'id > /tmp/pwn'").is_err());
        // Case-insensitive.
        assert!(set_remote_url_at(&root, "origin", "EXT::sh -c 'id > /tmp/pwn'").is_err());

        let repo2 = Repository::open(&root).unwrap();
        assert_eq!(
            repo2.find_remote("origin").unwrap().url().unwrap(),
            "https://example.com/orig.git",
            "unchanged"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A17 / A18 / A19: branch upstream ----

    fn make_remote_tracking_branch(
        repo: &Repository,
        remote: &str,
        branch: &str,
        target: git2::Oid,
    ) {
        repo.reference(
            &format!("refs/remotes/{remote}/{branch}"),
            target,
            true,
            "test",
        )
        .unwrap();
    }

    #[test]
    fn set_branch_upstream_writes_exact_remote_and_merge_keys() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "upstream_set";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        make_remote_tracking_branch(&repo, "origin", "main", head_oid);
        let current = git::current_branch(&repo).unwrap();

        set_branch_upstream_at(&root, &current, Some("origin/main")).unwrap();

        let config = repo.config().unwrap();
        assert_eq!(
            config
                .get_string(&format!("branch.{current}.remote"))
                .unwrap(),
            "origin"
        );
        assert_eq!(
            config
                .get_string(&format!("branch.{current}.merge"))
                .unwrap(),
            "refs/heads/main"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_upstream_naming_a_dead_branch_or_remote() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "upstream_reject";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/x.git").unwrap();
        let current = git::current_branch(&repo).unwrap();

        // Remote-tracking branch doesn't exist.
        assert!(set_branch_upstream_at(&root, &current, Some("origin/does-not-exist")).is_err());
        // Remote itself isn't configured.
        assert!(set_branch_upstream_at(&root, &current, Some("ghost/main")).is_err());

        let config = repo.config().unwrap();
        assert!(matches!(
            config.get_string(&format!("branch.{current}.remote")),
            Err(e) if e.code() == git2::ErrorCode::NotFound
        ));
        assert!(matches!(
            config.get_string(&format!("branch.{current}.merge")),
            Err(e) if e.code() == git2::ErrorCode::NotFound
        ));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- fix 2: `origin/HEAD` is never offered or accepted as an upstream ----

    #[test]
    fn origin_head_is_excluded_from_the_picker_and_rejected_as_an_upstream() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "upstream_origin_head";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        make_remote_tracking_branch(&repo, "origin", "main", head_oid);
        // A symbolic `refs/remotes/origin/HEAD`, same as git creates on clone.
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test",
        )
        .unwrap();
        let current = git::current_branch(&repo).unwrap();

        let names = remote_tracking_names(&repo).unwrap();
        assert!(names.contains(&"origin/main".to_string()));
        assert!(
            !names.contains(&"origin/HEAD".to_string()),
            "origin/HEAD must never be offered by the upstream picker"
        );

        assert!(
            set_branch_upstream_at(&root, &current, Some("origin/HEAD")).is_err(),
            "origin/HEAD must be rejected as an upstream"
        );

        let config = repo.config().unwrap();
        assert!(
            matches!(
                config.get_string(&format!("branch.{current}.remote")),
                Err(e) if e.code() == git2::ErrorCode::NotFound
            ),
            "the rejected write left branch.<n>.remote unset"
        );
        assert!(
            matches!(
                config.get_string(&format!("branch.{current}.merge")),
                Err(e) if e.code() == git2::ErrorCode::NotFound
            ),
            "the rejected write left branch.<n>.merge unset"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn clearing_upstream_removes_both_keys_and_preserves_others() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "upstream_clear";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        make_remote_tracking_branch(&repo, "origin", "main", head_oid);
        let current = git::current_branch(&repo).unwrap();

        set_branch_upstream_at(&root, &current, Some("origin/main")).unwrap();
        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local
                .set_str(&format!("branch.{current}.description"), "kept")
                .unwrap();
        }

        set_branch_upstream_at(&root, &current, None).unwrap();

        let config = repo.config().unwrap();
        assert!(matches!(
            config.get_string(&format!("branch.{current}.remote")),
            Err(e) if e.code() == git2::ErrorCode::NotFound
        ));
        assert!(matches!(
            config.get_string(&format!("branch.{current}.merge")),
            Err(e) if e.code() == git2::ErrorCode::NotFound
        ));
        assert_eq!(
            config
                .get_string(&format!("branch.{current}.description"))
                .unwrap(),
            "kept"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A20: writes never touch global/system config ----

    #[test]
    fn writes_leave_isolated_global_and_system_config_unchanged() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "isolation";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/x.git").unwrap();
        let head_oid = repo.head().unwrap().target().unwrap();
        make_remote_tracking_branch(&repo, "origin", "main", head_oid);
        let current = git::current_branch(&repo).unwrap();

        // Seed the isolated global level so we can prove it stays exactly as
        // seeded, not merely that it stays empty. The isolated system level is
        // never seeded (no `/etc/gitconfig`-equivalent file exists in the temp
        // dir), so "no `system`-level row ever appears" is the meaningful proxy
        // for "system config untouched" — `open_level(System)` itself errors
        // when no on-disk file for that level exists yet to focus on.
        set_global(&repo, "user.email", "global@example.com");
        assert!(
            !levels_present(&repo).contains("system"),
            "system unseeded before writes"
        );

        set_identity_at(&root, IdentityField::Name, Some("Someone".to_string())).unwrap();
        set_remote_url_at(&root, "origin", "https://example.com/y.git").unwrap();
        set_branch_upstream_at(&root, &current, Some("origin/main")).unwrap();

        let global_after = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Global)
            .unwrap();
        assert_eq!(
            global_after.get_string("user.email").unwrap(),
            "global@example.com",
            "isolated global config unchanged"
        );
        assert_eq!(
            count_at_level(&repo, ConfigLevel::Global),
            1,
            "no new key landed in global"
        );
        assert!(
            !levels_present(&repo).contains("system"),
            "isolated system config still untouched after every curated write"
        );

        // The changed bytes did land in the repo's own local config.
        let local_config = std::fs::read_to_string(repo.path().join("config")).unwrap();
        assert!(local_config.contains("Someone"));
        assert!(local_config.contains("y.git"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A21: a curated write preserves an externally-added key ----

    #[test]
    fn curated_write_preserves_an_externally_added_key() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "external_survives";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");

        // Load the overview (as the panel would)...
        let config = repo.config().unwrap();
        let _ = read_entries(&config).unwrap();

        // ...then an unrelated key is written by a second, independent handle.
        {
            let mut second = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            second.set_str("some.external", "value").unwrap();
        }

        set_identity_at(
            &root,
            IdentityField::Name,
            Some("Curated Writer".to_string()),
        )
        .unwrap();

        let after = repo.config().unwrap();
        assert_eq!(after.get_string("some.external").unwrap(), "value");
        assert_eq!(after.get_string("user.name").unwrap(), "Curated Writer");

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A22: origin URL write drops the cached slug; non-origin doesn't need to ----

    /// A fully-populated `AppState` (all other fields harmless defaults), for a
    /// test that needs `invalidate_origin_slug` reachable with no Tauri
    /// `AppHandle` to draw a `State` from — mirrors
    /// `diagnostics::tests::state_with_error_log`. `invalidate_origin_slug`
    /// takes `&AppState` (not `&State<AppState>`) for exactly this reason.
    fn bare_app_state() -> crate::state::AppState {
        use crate::state::GIT_STATUS_CONCURRENCY;
        use rusqlite::Connection;
        use std::collections::VecDeque;
        use std::sync::Mutex;
        use tokio::sync::Semaphore;

        crate::state::AppState {
            db: Mutex::new(Connection::open_in_memory().unwrap()),
            gh_token: Mutex::new(None),
            watcher: Mutex::new(None),
            bound_folders: Mutex::new(Vec::new()),
            watched_entry_dirs: Mutex::new(std::collections::HashMap::new()),
            resync_lock: Mutex::new(()),
            terminals: Mutex::new(std::collections::HashMap::new()),
            terminal_registry: Mutex::new(Vec::new()),
            git_gate: Semaphore::new(GIT_STATUS_CONCURRENCY),
            origin_slug_cache: Mutex::new(std::collections::HashMap::new()),
            op_log: Mutex::new(VecDeque::new()),
            error_log: Mutex::new(VecDeque::new()),
            ide: Mutex::new(None),
        }
    }

    #[test]
    fn origin_url_write_invalidates_cached_slug() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "slug_invalidate";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/old.git")
            .unwrap();
        repo.remote("upstream", "https://example.com/other.git")
            .unwrap();

        let state = bare_app_state();
        state
            .origin_slug_cache
            .lock()
            .unwrap()
            .insert(1, ("old-owner".to_string(), "old-repo".to_string()));

        set_remote_url_at(&root, "origin", "https://example.com/new.git").unwrap();
        // Gated by the same decision the production command makes — a test
        // that instead invalidated unconditionally would keep passing even if
        // that `if` were deleted from `git_config_set_remote_url`.
        if should_invalidate_origin_slug("origin") {
            crate::commands::repo::invalidate_origin_slug(&state, 1);
        }
        assert!(!state.origin_slug_cache.lock().unwrap().contains_key(&1));

        // Seed again and prove a non-origin write doesn't need to (and the
        // write still succeeds without touching the cache).
        state
            .origin_slug_cache
            .lock()
            .unwrap()
            .insert(1, ("owner".to_string(), "repo".to_string()));
        set_remote_url_at(&root, "upstream", "https://example.com/other2.git").unwrap();
        if should_invalidate_origin_slug("upstream") {
            crate::commands::repo::invalidate_origin_slug(&state, 1);
        }
        assert!(state.origin_slug_cache.lock().unwrap().contains_key(&1));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- fix 6: the origin-slug-cache decision is its own testable unit ----

    #[test]
    fn should_invalidate_origin_slug_is_true_only_for_origin() {
        assert!(should_invalidate_origin_slug("origin"));
        assert!(!should_invalidate_origin_slug("upstream"));
        assert!(!should_invalidate_origin_slug("origin2"));
    }

    // ---- fix 7: a remote with a distinct pushurl discloses it ----

    #[test]
    fn read_remotes_reports_a_pushurl_when_one_is_set() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "remote_pushurl";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/fetch.git")
            .unwrap();
        repo.remote_set_pushurl("origin", Some("https://example.com/push.git"))
            .unwrap();
        repo.remote("upstream", "https://example.com/other.git")
            .unwrap();

        let repo2 = Repository::open(&root).unwrap();
        let remotes = read_remotes(&repo2).unwrap();
        let origin = remotes.iter().find(|r| r.name == "origin").unwrap();
        assert_eq!(
            origin.push_url.as_deref(),
            Some("https://example.com/push.git")
        );
        let upstream = remotes.iter().find(|r| r.name == "upstream").unwrap();
        assert_eq!(upstream.push_url, None, "no pushurl configured");

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A23: remote picker lists every remote; branch picker targets the chosen branch ----

    #[test]
    fn overview_lists_every_remote_and_every_branch() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "multi_remote_branch";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        repo.remote("origin", "https://example.com/a.git").unwrap();
        repo.remote("upstream", "https://example.com/b.git")
            .unwrap();
        let head_oid = repo.head().unwrap().target().unwrap();
        make_remote_tracking_branch(&repo, "origin", "main", head_oid);
        make_remote_tracking_branch(&repo, "upstream", "main", head_oid);
        let head_commit = repo.find_commit(head_oid).unwrap();
        repo.branch("second", &head_commit, false).unwrap();

        let repo2 = Repository::open(&root).unwrap();
        let overview = build_overview(&repo2, &[]).unwrap();
        assert_eq!(overview.remotes.len(), 2);
        assert!(overview.remotes.iter().any(|r| r.name == "origin"));
        assert!(overview.remotes.iter().any(|r| r.name == "upstream"));
        assert_eq!(overview.branches.len(), 2);
        assert!(overview.branches.iter().any(|b| b.name == "second"));

        // Targeting the non-HEAD branch's upstream only touches that branch.
        set_branch_upstream_at(&root, "second", Some("upstream/main")).unwrap();
        let config = repo2.config().unwrap();
        assert_eq!(
            config.get_string("branch.second.remote").unwrap(),
            "upstream"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- A26: linked worktree ----

    #[test]
    fn read_and_identity_write_work_from_a_linked_worktree() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "worktree";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        drop(repo);

        let wt_path = root.parent().unwrap().join(format!(
            "gamut_config_test_worktree_{}_wt",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&wt_path);
        let out = std::process::Command::new("git")
            .args(["worktree", "add", "-b", "wt-branch"])
            .arg(&wt_path)
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let wt_repo = Repository::open(&wt_path).unwrap();
        let overview = build_overview(&wt_repo, &[]).unwrap();
        assert!(!overview.branches.is_empty());

        set_identity_at(
            &wt_path,
            IdentityField::Name,
            Some("Worktree Writer".to_string()),
        )
        .unwrap();
        let read_back = std::process::Command::new("git")
            .args(["config", "user.name"])
            .current_dir(&wt_path)
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&read_back.stdout).trim(),
            "Worktree Writer"
        );

        let _ = std::process::Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&wt_path)
            .current_dir(&root)
            .output();
        std::fs::remove_dir_all(&root).unwrap();
        let _ = std::fs::remove_dir_all(&wt_path);
    }

    // ---- A2: ahead/behind vs. a "remote = ." local-tracking upstream ----

    #[test]
    fn read_branches_reports_ahead_and_behind_against_a_local_upstream() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "branch_ahead_behind";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "base\n");
        let base_oid = repo.head().unwrap().target().unwrap();
        let base_commit = repo.find_commit(base_oid).unwrap();

        // "topic": base + 2 commits of its own (ahead).
        repo.branch("topic", &base_commit, false).unwrap();
        let topic_c1 = commit_on(&repo, base_oid, "b.txt", "one\n");
        repo.reference("refs/heads/topic", topic_c1, true, "test")
            .unwrap();
        let topic_c2 = commit_on(&repo, topic_c1, "c.txt", "two\n");
        repo.reference("refs/heads/topic", topic_c2, true, "test")
            .unwrap();

        // "up" stands in for the upstream: base + 1 different commit (behind).
        repo.branch("up", &base_commit, false).unwrap();
        let up_c1 = commit_on(&repo, base_oid, "d.txt", "up-only\n");
        repo.reference("refs/heads/up", up_c1, true, "test")
            .unwrap();

        // `remote = "."` is git's own convention for tracking a local branch —
        // `Branch::upstream()` resolves it the same way as a real remote.
        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local.set_str("branch.topic.remote", ".").unwrap();
            local
                .set_str("branch.topic.merge", "refs/heads/up")
                .unwrap();
        }

        let config = repo.config().unwrap();
        let branches = read_branches(&repo, &config, &[]).unwrap();
        let topic = branches.iter().find(|b| b.name == "topic").unwrap();
        assert_eq!(topic.ahead, Some(2), "topic has 2 commits `up` lacks");
        assert_eq!(topic.behind, Some(1), "topic lacks `up`'s 1 commit");

        // "up" itself has no upstream configured — never a fabricated `0`.
        let up = branches.iter().find(|b| b.name == "up").unwrap();
        assert_eq!(up.ahead, None);
        assert_eq!(up.behind, None);

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- merged flag ----

    #[test]
    fn branch_is_merged_true_for_ancestor_and_identical_tip_false_otherwise() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "branch_merged";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "base\n");
        let base_oid = repo.head().unwrap().target().unwrap();
        let base_commit = repo.find_commit(base_oid).unwrap();

        // "merged-into-head": base only, HEAD has since moved on — its tip is an
        // ancestor of HEAD, so it counts as merged.
        repo.branch("merged-into-head", &base_commit, false)
            .unwrap();
        commit_file(&repo, "b.txt", "second\n");

        // "same-as-head": at HEAD's own current tip — merged (identical, not
        // just an ancestor).
        let head_oid = repo.head().unwrap().target().unwrap();
        repo.branch("same-as-head", &repo.find_commit(head_oid).unwrap(), false)
            .unwrap();

        // "unmerged": diverges from HEAD with a commit HEAD doesn't have.
        let unmerged_oid = commit_on(&repo, base_oid, "c.txt", "diverged\n");
        repo.branch("unmerged", &repo.find_commit(unmerged_oid).unwrap(), false)
            .unwrap();

        let config = repo.config().unwrap();
        let branches = read_branches(&repo, &config, &[]).unwrap();
        let merged = |name: &str| branches.iter().find(|b| b.name == name).unwrap().merged;
        assert!(merged("merged-into-head"));
        assert!(merged("same-as-head"));
        assert!(!merged("unmerged"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    // ---- MEDIUM-2: protected flag ----

    #[test]
    fn read_branches_marks_main_protected_by_default_and_others_not() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "branch_protected";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "hello\n");
        let head_oid = repo.head().unwrap().target().unwrap();
        let head_commit = repo.find_commit(head_oid).unwrap();
        // `temp_repo` uses `Repository::init` with no explicit initial branch
        // name override, so the default branch here is whatever the test git
        // install defaults to — create an explicit "main" so the assertion
        // doesn't depend on that default, and switch HEAD to a third branch
        // (via `set_head`, not a working-tree checkout — nothing here reads
        // the working tree) so neither "main" nor "feature" is protected via
        // the separate "currently checked out" rule, only via the configured
        // protected-branches list under test.
        if git::current_branch(&repo).as_deref() != Some("main") {
            repo.branch("main", &head_commit, false).unwrap();
        }
        repo.branch("feature", &head_commit, false).unwrap();
        repo.branch("other", &head_commit, false).unwrap();
        repo.set_head("refs/heads/other").unwrap();
        assert_eq!(git::current_branch(&repo).as_deref(), Some("other"));

        let config = repo.config().unwrap();
        let default_protected = vec!["main".to_string(), "master".to_string()];
        let branches = read_branches(&repo, &config, &default_protected).unwrap();
        let protected = |name: &str| branches.iter().find(|b| b.name == name).unwrap().protected;
        assert!(protected("main"), "main is protected by the default list");
        assert!(!protected("feature"), "an ordinary branch is not protected");

        // A configured override replaces the default list entirely — a repo
        // that opts "feature" in as protected (and drops "main") sees exactly
        // that reflected.
        let override_list = vec!["feature".to_string()];
        let branches = read_branches(&repo, &config, &override_list).unwrap();
        let protected = |name: &str| branches.iter().find(|b| b.name == name).unwrap().protected;
        assert!(
            protected("feature"),
            "override list makes feature protected"
        );
        assert!(
            !protected("main"),
            "override list drops main from protection"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// `git branch -d` also permits deleting a branch merged into its own
    /// upstream, not only into HEAD. Here HEAD never advances past `base`, so
    /// "feature" is NOT merged into HEAD, but its upstream (`origin/feature`)
    /// is one commit ahead of feature's own tip — everything on "feature"
    /// already lives in the upstream — so it must still read as merged.
    #[test]
    fn branch_is_merged_true_when_merged_only_into_its_upstream() {
        let _guard = CONFIG_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tag = "branch_merged_upstream";
        let _search_guard = isolate_search_paths(tag);
        let (root, repo) = temp_repo(tag);
        commit_file(&repo, "a.txt", "base\n");
        let base_oid = repo.head().unwrap().target().unwrap();

        let branch_oid = commit_on(&repo, base_oid, "b.txt", "on branch\n");
        repo.branch("feature", &repo.find_commit(branch_oid).unwrap(), false)
            .unwrap();

        // The upstream is one commit further along than "feature"'s own tip.
        let upstream_ahead_oid = commit_on(&repo, branch_oid, "c.txt", "on upstream too\n");
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.reference(
            "refs/remotes/origin/feature",
            upstream_ahead_oid,
            true,
            "test",
        )
        .unwrap();
        {
            let mut local = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local.set_str("branch.feature.remote", "origin").unwrap();
            local
                .set_str("branch.feature.merge", "refs/heads/feature")
                .unwrap();
        }

        // HEAD is still at `base` — "feature" is not merged into HEAD.
        let head_oid = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .map(|c| c.id());
        assert_eq!(head_oid, Some(base_oid));

        let branch = repo.find_branch("feature", BranchType::Local).unwrap();
        assert!(
            branch_is_merged(&repo, &branch, head_oid),
            "merged into its own upstream tip counts as merged, even though \
             HEAD hasn't advanced past base"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }
}
