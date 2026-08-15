use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use git2::BranchType;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::settings;
use crate::error::{AppError, AppResult};
use crate::git;
use crate::state::AppState;

#[derive(Serialize)]
pub struct Repo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub last_opened: Option<String>,
    pub created_at: String,
    pub tag_ids: Vec<i64>,
    pub group_ids: Vec<i64>,
    /// True when the repo's directory no longer exists on disk (e.g. it was
    /// deleted or moved out of a bound folder). Surfaced as a "missing" flag in
    /// the UI; folder sync never auto-removes such repos.
    pub missing: bool,
    /// True when the entry is an actual git repository. Plain (non-git) folders
    /// can be added too; for those the UI shows only the Files tab and the
    /// backend skips all git operations (status, branches, ahead/behind).
    pub is_git_repo: bool,
    /// Cached "has any linked worktree" flag (maintained by the status scan).
    /// The UI uses it to decide whether to run the per-repo `git worktree list`
    /// at all — repos with none skip it entirely. May lag reality until the
    /// next status scan; the live value rides on `RepoStatus`.
    pub has_worktrees: bool,
    /// Opted into background auto-pull (#299): when the app notices this repo is
    /// behind its upstream it fast-forwards the branch, without the user clicking
    /// pull. Off by default, and only ever a clean fast-forward — the eligibility
    /// rules and the skip-and-warn behaviour live in `sync::git_pull_ff_many`.
    pub auto_pull: bool,
}

#[derive(Serialize)]
pub struct DiscoveredRepo {
    pub path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub already_registered: bool,
}

pub(crate) fn lock(state: &AppState) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
    state
        .db
        .lock()
        .map_err(|e| AppError::Other(format!("db lock poisoned: {e}")))
}

fn ids_for(conn: &Connection, sql: &str, repo_id: i64) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let ids = stmt
        .query_map([repo_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Collect a `(repo_id, value)` join table into a `repo_id → [value]` map in a
/// single query, so the list endpoint doesn't run one query per repo (#136).
/// `sql` must select `repo_id` first and the value id second.
fn id_map(conn: &Connection, sql: &str) -> AppResult<HashMap<i64, Vec<i64>>> {
    let mut stmt = conn.prepare(sql)?;
    let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
    let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))?;
    for row in rows {
        let (repo_id, value) = row?;
        map.entry(repo_id).or_default().push(value);
    }
    Ok(map)
}

fn load_repo(conn: &Connection, id: i64) -> AppResult<Repo> {
    let (
        path,
        name,
        default_branch,
        last_opened,
        created_at,
        is_git_repo,
        has_worktrees,
        auto_pull,
    ) = conn.query_row(
        "SELECT path, name, default_branch, last_opened, created_at, is_git_repo, has_worktrees,
                auto_pull
         FROM repos WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)? != 0,
                row.get::<_, i64>(6)? != 0,
                row.get::<_, i64>(7)? != 0,
            ))
        },
    )?;

    // Missing covers a deleted/moved folder and a path that exists but is
    // not a directory (a file row registered before the is_dir guard).
    let missing = !std::path::Path::new(&path).is_dir();

    Ok(Repo {
        id,
        path,
        name,
        default_branch,
        last_opened,
        created_at,
        tag_ids: ids_for(conn, "SELECT tag_id FROM repo_tags WHERE repo_id = ?1", id)?,
        group_ids: ids_for(
            conn,
            "SELECT group_id FROM repo_groups WHERE repo_id = ?1",
            id,
        )?,
        missing,
        is_git_repo,
        has_worktrees,
        auto_pull,
    })
}

/// Register a folder path into the DB (idempotent). Returns its row id and
/// whether the row was newly inserted (false = it already existed). Shared by
/// the manual `register_repo` command and folder auto-sync.
///
/// `git::open` stays strict: a real git repo records its current branch and is
/// flagged `is_git_repo`. A plain (non-git) folder is recorded as a non-git
/// entry instead of failing registration — the UI shows only the Files tab for
/// it and the backend skips all git operations.
fn register_path(conn: &Connection, path: &std::path::Path) -> AppResult<(i64, bool)> {
    // Only directories can be repos or folder entries — reject files here so a
    // file dropped onto the sidebar (or sent by a scan) can't register as a
    // phantom "folder" row.
    if !path.is_dir() {
        return Err(AppError::NotADirectory(path.display().to_string()));
    }
    let (branch, is_git_repo) = match git::open(path) {
        Ok(repo) => (git::current_branch(&repo), true),
        Err(AppError::NotARepo(_)) => (None, false),
        Err(e) => return Err(e),
    };
    let name = git::repo_name(path);
    let canonical = path
        .canonicalize()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.display().to_string());
    let existed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM repos WHERE path = ?1)",
        [&canonical],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO repos (path, name, default_branch, is_git_repo) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, default_branch = excluded.default_branch, is_git_repo = excluded.is_git_repo",
        rusqlite::params![canonical, name, branch, is_git_repo as i64],
    )?;
    let id = conn.query_row("SELECT id FROM repos WHERE path = ?1", [&canonical], |r| {
        r.get(0)
    })?;
    Ok((id, !existed))
}

/// Default recursion depth for folder discovery (matches the manual scan).
const SYNC_DEPTH: usize = 6;

/// Discovery depth + prune list, applying any `pref.` overrides. Reads from a
/// held connection so it's safe to call while the db lock is taken.
fn discovery_opts(conn: &Connection) -> (usize, Vec<String>) {
    let depth = settings::parsed_conn(conn, "pref.scanDepth", SYNC_DEPTH);
    let prune = settings::get_conn(conn, "pref.pruneDirs")
        .map(|raw| settings::parse_csv(&raw))
        .filter(|list| !list.is_empty())
        .unwrap_or_else(git::default_prune_dirs);
    (depth, prune)
}

/// The prune list the filesystem watcher uses to skip heavy/ignored
/// directories (e.g. `node_modules`) inside a repo's working tree, mirroring
/// the folder-scan discovery options so the two stay consistent.
pub fn watch_prune_dirs(state: &AppState) -> Vec<String> {
    let Ok(conn) = state.db.lock() else {
        return git::default_prune_dirs();
    };
    discovery_opts(&conn).1
}

/// Scan a bound group's folder and add (never remove) the folder itself plus
/// every discovered git repo and repo-free leaf folder to the group. Add-only
/// and idempotent: entries already registered/assigned are untouched. Honors the
/// scanner's prune list. Stamps `last_scan_at`.
///
/// The default group is special: it surfaces *ungrouped* repos (no explicit
/// membership), so binding it auto-registers discovered repos without creating
/// `repo_groups` rows — registration alone makes them appear there. For any
/// other group, discovered repos are added as explicit members.
///
/// Returns the count of newly-surfaced repos (new memberships for a normal
/// group; newly-registered repos for the default group).
pub fn sync_folder_group(conn: &Connection, group_id: i64, folder: &str) -> AppResult<usize> {
    let (depth, prune) = discovery_opts(conn);
    let paths = discover_folder_paths(folder, depth, &prune);
    apply_folder_sync(conn, group_id, &paths)
}

/// The paths a bound folder contributes to its group: the folder itself (so
/// its Files tab browses the whole synced tree) plus everything discovered
/// inside it — git repos and repo-free leaf folders alike. Pure disk I/O — no
/// DB access, so callers that own the connection lock can walk without it.
fn discover_folder_paths(folder: &str, depth: usize, prune: &[String]) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = vec![PathBuf::from(folder)];
    paths.extend(
        git::discover(&PathBuf::from(folder), depth, prune)
            .into_iter()
            .map(|d| d.path),
    );
    paths
}

/// Register discovered `paths` into the group (add-only, idempotent) and stamp
/// `last_scan_at`. `register_path` classifies each as git/non-git on its own.
/// Returns the count of newly-surfaced repos (see `sync_folder_group`).
fn apply_folder_sync(conn: &Connection, group_id: i64, paths: &[PathBuf]) -> AppResult<usize> {
    let is_default: bool = conn
        .query_row(
            "SELECT is_default FROM groups WHERE id = ?1",
            [group_id],
            |r| r.get::<_, i64>(0),
        )
        .map(|v| v != 0)
        .unwrap_or(false);

    let mut added = 0usize;
    for path in paths {
        let Ok((repo_id, inserted)) = register_path(conn, path) else {
            continue;
        };
        if is_default {
            if inserted {
                added += 1;
            }
        } else {
            added += conn.execute(
                "INSERT OR IGNORE INTO repo_groups (repo_id, group_id) VALUES (?1, ?2)",
                rusqlite::params![repo_id, group_id],
            )?;
        }
    }
    conn.execute(
        "UPDATE groups SET last_scan_at = datetime('now') WHERE id = ?1",
        [group_id],
    )?;
    Ok(added)
}

/// Sync every folder-bound group. Used by the filesystem watcher when a change
/// under a bound folder suggests a new repo appeared (`suggests_new_repo`).
/// Returns the total number of new memberships added across all groups; the
/// caller resyncs the watcher when repos were added, since bound folders are
/// watched non-recursively and nothing else covers a new repo's tree.
///
/// The disk walk runs *without* the DB lock: it can take seconds on a large
/// bound tree, every UI command needs the same connection, and holding the
/// lock across the walk stalled the whole app (group switches queued behind
/// it). The lock is taken briefly to read the group list and again per group
/// to apply the walk's results.
pub fn sync_all_bound_groups(state: &AppState) -> usize {
    let (bound, depth, prune): (Vec<(i64, String)>, usize, Vec<String>) = {
        let Ok(conn) = state.db.lock() else {
            return 0;
        };
        let bound = conn
            .prepare(
                "SELECT id, folder_path FROM groups
                 WHERE folder_path IS NOT NULL AND folder_path != ''",
            )
            .and_then(|mut stmt| {
                stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
                    .map(|it| it.filter_map(Result::ok).collect())
            })
            .unwrap_or_default();
        let (depth, prune) = discovery_opts(&conn);
        (bound, depth, prune)
    };
    let mut total = 0;
    for (id, folder) in bound {
        let paths = discover_folder_paths(&folder, depth, &prune);
        let Ok(conn) = state.db.lock() else {
            return total;
        };
        total += apply_folder_sync(&conn, id, &paths).unwrap_or(0);
    }
    total
}

/// Scan a single folder-bound group's folder now and add any new repos. Used
/// for the initial scan on bind and the "Rescan now" button. Returns the count
/// of newly-added repos.
#[tauri::command]
pub fn sync_group_folder(
    app: AppHandle,
    state: State<AppState>,
    group_id: i64,
) -> AppResult<usize> {
    let added = {
        let conn = lock(&state)?;
        let folder: Option<String> = conn.query_row(
            "SELECT folder_path FROM groups WHERE id = ?1",
            [group_id],
            |r| r.get(0),
        )?;
        match folder.filter(|p| !p.trim().is_empty()) {
            Some(folder) => sync_folder_group(&conn, group_id, &folder)?,
            None => return Ok(0),
        }
    };
    // Pick up newly-registered repos (and the folder itself) for watching.
    crate::watch::resync(&app);
    Ok(added)
}

#[tauri::command]
pub fn list_repos(state: State<AppState>) -> AppResult<Vec<Repo>> {
    let conn = lock(&state)?;
    list_repos_from_conn(&conn)
}

/// Absolute paths of every registered repo, used to seed the Claude Code IDE
/// server's `workspaceFolders` at startup (see `crate::claude_ide`). Read once —
/// repos added/removed later won't reflect until the app restarts, since a
/// `claude` reads the lockfile only when it first connects.
pub fn all_repo_paths(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM repos ORDER BY sort, name COLLATE NOCASE")?;
    let paths = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(paths)
}

/// List every registered repo, ordered as the sidebar shows them. Split out of
/// the [`list_repos`] command so the query core takes a plain `&Connection`.
fn list_repos_from_conn(conn: &Connection) -> AppResult<Vec<Repo>> {
    // Two batch queries for the join tables instead of two per repo — the old
    // per-repo `load_repo` was 1 + 2 queries each (150 queries for 50 repos) on
    // the sidebar's hottest command (#136).
    let mut tags = id_map(conn, "SELECT repo_id, tag_id FROM repo_tags")?;
    let mut groups = id_map(conn, "SELECT repo_id, group_id FROM repo_groups")?;

    let mut stmt = conn.prepare(
        "SELECT id, path, name, default_branch, last_opened, created_at, is_git_repo,
                has_worktrees, auto_pull
         FROM repos ORDER BY sort, name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)? != 0,
                row.get::<_, i64>(7)? != 0,
                row.get::<_, i64>(8)? != 0,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                path,
                name,
                default_branch,
                last_opened,
                created_at,
                is_git_repo,
                has_worktrees,
                auto_pull,
            )| {
                // Missing covers a deleted/moved folder and a path that exists but is
                // not a directory (a file row registered before the is_dir guard).
                let missing = !std::path::Path::new(&path).is_dir();
                Repo {
                    id,
                    path,
                    name,
                    default_branch,
                    last_opened,
                    created_at,
                    tag_ids: tags.remove(&id).unwrap_or_default(),
                    group_ids: groups.remove(&id).unwrap_or_default(),
                    missing,
                    is_git_repo,
                    has_worktrees,
                    auto_pull,
                }
            },
        )
        .collect())
}

/// Register a repo by path. Validates it's a git repo, derives name and
/// current branch. If the path is already registered, returns the existing row.
#[tauri::command]
pub fn register_repo(app: AppHandle, state: State<AppState>, path: String) -> AppResult<Repo> {
    let conn = lock(&state)?;
    let (id, _) = register_path(&conn, &PathBuf::from(&path))?;
    let repo = load_repo(&conn, id)?;
    drop(conn); // release the DB lock before resync re-reads it
                // The (re-)registered repo's origin may have changed; drop any stale slug.
    invalidate_origin_slug(&state, id);
    crate::watch::resync(&app);
    Ok(repo)
}

/// Remove one or more repos from Gamut in a single IPC round trip. DB-only —
/// never touches anything on disk, no `git worktree remove`: a bound
/// `DELETE FROM repos WHERE id IN (…)` cascades `repo_tags`/`repo_groups` via
/// the schema's `ON DELETE CASCADE` FKs, then one `watch::resync` picks up the
/// change (not once per removed repo). A single-repo removal just passes a
/// one-element vec. Empty `ids` is a no-op: no DB write, no resync.
#[tauri::command]
pub fn remove_repos(app: AppHandle, state: State<AppState>, ids: Vec<i64>) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let conn = lock(&state)?;
    delete_repos(&conn, &ids)?;
    drop(conn); // release the DB lock before resync re-reads it
    for id in &ids {
        invalidate_origin_slug(&state, *id);
    }
    crate::watch::resync(&app);
    Ok(())
}

/// Query core of [`remove_repos`]: delete every listed id from `repos` in one
/// statement, over a plain `&Connection` so a test can exercise the SQL (and its
/// FK cascade to `repo_tags`/`repo_groups`) without a Tauri `AppHandle`. Ids are
/// bound placeholders — never string-interpolated into the SQL. A no-op for an
/// empty list, and tolerant of ids that don't exist (nothing to delete).
fn delete_repos(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("DELETE FROM repos WHERE id IN ({placeholders})");
    let params: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    conn.execute(&sql, params.as_slice())?;
    Ok(())
}

/// Drop a repo's cached `origin` owner/repo slug (#136), so a later GitHub call
/// re-resolves it. Best-effort: a poisoned lock just leaves the stale entry.
///
/// Takes `&AppState` rather than `&State<AppState>` so it's callable both from a
/// command's `State<AppState>` param (deref-coerces automatically) and directly
/// against a bare `AppState` in a test with no Tauri app to draw a `State` from.
/// `pub(crate)` (rather than private) so `commands::config`'s remote-URL write
/// can invalidate the cache after editing `origin` (#306 impact hazard 1).
pub(crate) fn invalidate_origin_slug(state: &AppState, id: i64) {
    if let Ok(mut cache) = state.origin_slug_cache.lock() {
        cache.remove(&id);
    }
}

/// Turn background auto-pull on or off for one repo (#299) — the per-repo opt-in
/// behind the sidebar's context-menu toggle. Only this repo's flag changes; the
/// pull itself stays fast-forward-only regardless (`sync::git_pull_ff_many`).
#[tauri::command]
pub fn set_repo_auto_pull(state: State<AppState>, repo_id: i64, enabled: bool) -> AppResult<()> {
    let conn = lock(&state)?;
    set_auto_pull(&conn, repo_id, enabled)
}

/// Query core of [`set_repo_auto_pull`], over a plain `&Connection` so a test can
/// exercise the write (and its per-repo scoping) without a Tauri `State`.
fn set_auto_pull(conn: &Connection, repo_id: i64, enabled: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE repos SET auto_pull = ?1 WHERE id = ?2",
        rusqlite::params![enabled as i64, repo_id],
    )?;
    Ok(())
}

/// Persist a new ordering for repos (drag-and-drop). `repo_ids` is the desired
/// order; each repo's `sort` is set to its index.
#[tauri::command]
pub fn reorder_repos(state: State<AppState>, repo_ids: Vec<i64>) -> AppResult<()> {
    let mut conn = lock(&state)?;
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare("UPDATE repos SET sort = ?1 WHERE id = ?2")?;
        for (idx, id) in repo_ids.iter().enumerate() {
            stmt.execute(rusqlite::params![idx as i64, id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

#[tauri::command]
pub fn touch_repo(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = lock(&state)?;
    conn.execute(
        "UPDATE repos SET last_opened = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct RepoStatus {
    pub id: i64,
    pub branch: Option<String>,
    pub ahead: usize,
    pub behind: usize,
    /// True when the working tree has staged, unstaged, or untracked changes.
    /// Surfaced as a dirty indicator in the sidebar.
    pub has_uncommitted_changes: bool,
    /// True when the repo has any linked worktree (`git worktree add`). The
    /// live value; the persisted `Repo.has_worktrees` is refreshed from it.
    /// The UI uses it to decide whether to run `git worktree list` at all.
    pub has_worktrees: bool,
}

/// Whether the repo's working tree has any uncommitted changes — staged,
/// unstaged, or untracked. Also the cleanliness predicate for auto-pull (#299),
/// which skips a repo rather than fast-forwarding it when this is true; that is
/// deliberately stricter than `git merge --ff-only` (which tolerates untracked
/// files), so "clean" means the same thing to the sidebar dot and to auto-pull.
/// This is the cheap "is there *any* change?" check for
/// the sidebar dirty-dot, so it differs from `git_worktree_status`'s two-diff
/// scan (#138): a single `statuses()` pass that stops at the first untracked
/// *directory* rather than walking its files. HEAD may be unborn (a fresh
/// repo) — then the index alone counts.
pub(crate) fn has_uncommitted_changes(repo: &git2::Repository) -> bool {
    let mut opts = git2::StatusOptions::new();
    // A single status pass covers staged (HEAD→index) and unstaged (index→wd)
    // changes plus untracked files, instead of two full working-tree diffs
    // (#136). For the sidebar dirty-dot we only need "is there *any* change", so
    // we don't recurse into untracked directories — an untracked dir is then a
    // single entry rather than a walk of all its files, which was the expensive
    // part of the convoy flagged in #89. Submodules are excluded for the same
    // "any change in *this* tree" reason.
    opts.include_untracked(true)
        .recurse_untracked_dirs(false)
        .exclude_submodules(true);
    repo.statuses(Some(&mut opts))
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}

/// Per-repo current branch and ahead/behind vs its upstream (local-only; the
/// behind count reflects the last fetch — "new commits available" after fetching).
#[tauri::command]
pub async fn repo_statuses(state: State<'_, AppState>) -> AppResult<Vec<RepoStatus>> {
    repo_statuses_impl(&state, None).await
}

/// Statuses for just the given repos — the watcher's scoped refresh path (see
/// useGitWatch), so one repo changing doesn't rescan the whole fleet.
#[tauri::command]
pub async fn repo_statuses_for(
    state: State<'_, AppState>,
    repo_ids: Vec<i64>,
) -> AppResult<Vec<RepoStatus>> {
    repo_statuses_impl(&state, Some(repo_ids)).await
}

async fn repo_statuses_impl(
    state: &AppState,
    only: Option<Vec<i64>>,
) -> AppResult<Vec<RepoStatus>> {
    let started = std::time::Instant::now();
    let op = if only.is_some() {
        "repo_statuses_for"
    } else {
        "repo_statuses"
    };
    let only: Option<HashSet<i64>> = only.map(|ids| ids.into_iter().collect());
    // `stored` is the persisted has_worktrees per repo, so after the scan we can
    // write back only the ones that actually changed.
    let (scan_rows, stored): (Vec<(i64, String)>, HashMap<i64, bool>) = {
        let conn = lock(state)?;
        // Non-git folders have no branch / ahead-behind; skip them entirely so
        // the scan never touches a plain directory.
        let mut stmt =
            conn.prepare("SELECT id, path, has_worktrees FROM repos WHERE is_git_repo != 0")?;
        let mut scan_rows: Vec<(i64, String)> = Vec::new();
        let mut stored: HashMap<i64, bool> = HashMap::new();
        let iter = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })?;
        for row in iter {
            let (id, path, has_worktrees) = row?;
            if only.as_ref().is_some_and(|ids| !ids.contains(&id)) {
                continue;
            }
            stored.insert(id, has_worktrees);
            scan_rows.push((id, path));
        }
        (scan_rows, stored)
    };

    // Bound concurrency and get the blocking git2 work off the async runtime's
    // worker threads. This whole scan holds a single git-status permit, so it
    // can't stampede alongside per-repo worktree-status calls and trigger the
    // libiconv lock convoy (issue #89).
    let result =
        crate::commands::run_git_gated(state, move || compute_repo_statuses(scan_rows)).await;

    // Persist any change in linked-worktree presence so `Repo.has_worktrees`
    // (which gates whether the UI runs `git worktree list` per repo) survives a
    // restart. Worktree state rarely changes, so this usually writes nothing and
    // never takes the lock.
    if let Ok(statuses) = &result {
        let changed: Vec<(i64, bool)> = statuses
            .iter()
            .filter(|s| stored.get(&s.id) != Some(&s.has_worktrees))
            .map(|s| (s.id, s.has_worktrees))
            .collect();
        if !changed.is_empty() {
            if let Ok(conn) = lock(state) {
                for (id, has_worktrees) in changed {
                    let _ = conn.execute(
                        "UPDATE repos SET has_worktrees = ?1 WHERE id = ?2",
                        rusqlite::params![has_worktrees as i64, id],
                    );
                }
            }
        }
    }

    crate::commands::diagnostics::record(
        state,
        crate::commands::diagnostics::OpTiming::finished(
            op,
            None,
            started,
            result.is_ok(),
            Some(
                result
                    .as_ref()
                    .map(|v| format!("{} repos", v.len()))
                    .unwrap_or_else(|e| e.to_string()),
            ),
        ),
    );
    result
}

/// Blocking core of [`repo_statuses`]: compute each repo's status from its path.
fn compute_repo_statuses(rows: Vec<(i64, String)>) -> AppResult<Vec<RepoStatus>> {
    Ok(rows
        .into_iter()
        .map(|(id, path)| compute_repo_status(id, &path))
        .collect())
}

/// Whether the repo has any linked worktree (`git worktree add`). Cheap: git2
/// reads `.git/worktrees/` without spawning a subprocess, so it's fine to run
/// in the per-repo status scan — unlike the `git worktree list` CLI call the
/// UI needs for full details, which this flag lets it avoid for repos with none.
fn has_linked_worktrees(repo: &git2::Repository) -> bool {
    repo.worktrees().map(|w| !w.is_empty()).unwrap_or(false)
}

/// Compute a single repo's branch and ahead/behind from its path. Never errors:
/// an unreadable repo just yields a zeroed status (matching the batch scan).
fn compute_repo_status(id: i64, path: &str) -> RepoStatus {
    let mut status = RepoStatus {
        id,
        branch: None,
        ahead: 0,
        behind: 0,
        has_uncommitted_changes: false,
        has_worktrees: false,
    };
    if let Ok(repo) = git::open(std::path::Path::new(path)) {
        status.has_uncommitted_changes = has_uncommitted_changes(&repo);
        status.has_worktrees = has_linked_worktrees(&repo);
        if let Ok(head) = repo.head() {
            status.branch = head.shorthand().map(|s| s.to_string());
            if head.is_branch() {
                if let Some(b) = &status.branch {
                    if let Ok(local) = repo.find_branch(b, BranchType::Local) {
                        if let Ok(up) = local.upstream() {
                            if let (Some(l), Some(u)) = (local.get().target(), up.get().target()) {
                                if let Ok((a, behind)) = repo.graph_ahead_behind(l, u) {
                                    status.ahead = a;
                                    status.behind = behind;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    status
}

/// Single-repo variant of [`repo_statuses`] — recompute one repo's branch and
/// ahead/behind without rescanning every registered repo. The frontend calls
/// this right after a pull/push lands new refs so the ahead/behind count updates
/// immediately, instead of waiting on a gated all-repos scan (#101). Still goes
/// through the git-status gate so it can't stampede the libiconv lock (#89).
#[tauri::command]
pub async fn repo_status(state: State<'_, AppState>, repo_id: i64) -> AppResult<RepoStatus> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    let path = path.to_string_lossy().into_owned();
    crate::commands::run_git_gated(&state, move || Ok(compute_repo_status(repo_id, &path))).await
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
}

/// List local and remote branches; the current branch is flagged `is_head`.
#[tauri::command]
pub async fn list_branches(state: State<'_, AppState>, repo_id: i64) -> AppResult<Vec<BranchInfo>> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        let repo = git::open(p)?;
        let mut out = Vec::new();
        for kind in [BranchType::Local, BranchType::Remote] {
            for b in repo.branches(Some(kind))? {
                let (branch, _) = b?;
                if let Some(name) = branch.name()? {
                    out.push(BranchInfo {
                        name: name.to_string(),
                        is_head: branch.is_head(),
                        is_remote: matches!(kind, BranchType::Remote),
                    });
                }
            }
        }
        Ok(out)
    })
    .await
}

/// List tag names in the repository.
#[tauri::command]
pub async fn list_git_tags(state: State<'_, AppState>, repo_id: i64) -> AppResult<Vec<String>> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        let repo = git::open(p)?;
        let mut names: Vec<String> = repo
            .tag_names(None)?
            .iter()
            .flatten()
            .map(|s| s.to_string())
            .collect();
        names.sort();
        Ok(names)
    })
    .await
}

/// Check out a branch, tag, or commit (safe checkout — aborts if it would
/// overwrite local edits). Local branches stay attached, a remote branch becomes
/// a local branch tracking it, and tags/commits detach HEAD.
///
/// `checkout_tree` rewrites every working-tree file that differs between the two
/// branches, so this runs on a blocking thread rather than the async runtime's
/// worker pool — otherwise a large checkout would tie up an IPC worker and stall
/// the UI (#100, sibling of #88).
#[tauri::command]
pub async fn checkout_branch(
    state: State<'_, AppState>,
    repo_id: i64,
    name: String,
) -> AppResult<()> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| checkout_at(p, &name)).await
}

/// Where [`checkout_at`] points HEAD once the working tree is written.
enum HeadTarget {
    /// Attach to a local branch that already exists, at its own tip.
    Existing(String),
    /// Create local branch `local` at `commit`, attach to it, and set its
    /// upstream to the remote-tracking branch `upstream` it came from. The
    /// commit is carried from the ref that was matched rather than re-resolved
    /// later: `revparse_single` uses a wider precedence than the lookup here, so
    /// re-resolving could pick a different object (e.g. a stray
    /// `refs/origin/feature` outranking `refs/remotes/origin/feature`).
    Track {
        local: String,
        upstream: String,
        commit: git2::Oid,
    },
    /// A tag, a raw revision, or anything else with no local branch behind it.
    Detached,
}

/// Strip a configured remote's name — and only its name — off the front of a
/// branch shorthand: `origin/feature/nested` → `feature/nested`. Inner slashes
/// belong to the branch, so just the first segment is never the right rule. The
/// longest matching remote wins, so a remote called `origin/mirror` beats
/// `origin`. Returns `None` when no remote matches or nothing is left over.
///
/// A slash-bearing remote name can still leave the upstream genuinely ambiguous
/// (two remotes whose fetch refspecs both claim the ref); libgit2 rejects that
/// when the upstream is written, and the checkout fails before it touches the
/// working tree.
///
/// The remotes are passed in rather than read from the repo so the rule can be
/// tested on its own.
fn strip_remote_prefix<'a>(
    remotes: impl IntoIterator<Item = &'a str>,
    name: &str,
) -> Option<String> {
    remotes
        .into_iter()
        .filter_map(|remote| name.strip_prefix(remote)?.strip_prefix('/'))
        .filter(|rest| !rest.is_empty())
        // Longest remote matched == shortest remainder.
        .min_by_key(|rest| rest.len())
        .map(str::to_string)
}

/// Decide where HEAD lands for `name`, following git's ref precedence: a local
/// branch wins, then a tag, then a remote-tracking branch — which git's DWIM
/// turns into a local branch tracking it (#305). Anything else detaches.
fn resolve_head_target(repo: &git2::Repository, name: &str) -> AppResult<HeadTarget> {
    let local_ref = format!("refs/heads/{name}");
    if repo.find_reference(&local_ref).is_ok() {
        return Ok(HeadTarget::Existing(local_ref));
    }
    // A tag outranks a remote branch of the same name, and tags always detach.
    if repo.find_reference(&format!("refs/tags/{name}")).is_ok() {
        return Ok(HeadTarget::Detached);
    }
    let Ok(remote_ref) = repo.find_reference(&format!("refs/remotes/{name}")) else {
        // Not a remote-tracking ref: a raw sha, a bare name git will DWIM to
        // some other ref, or nothing at all. Left to `revparse_single`.
        return Ok(HeadTarget::Detached);
    };
    // `origin/HEAD` points at another ref instead of naming a branch of its own.
    // Checking one out has always detached and still should.
    if remote_ref.symbolic_target().is_some() {
        return Ok(HeadTarget::Detached);
    }

    let remotes = repo.remotes()?;
    let Some(local) = strip_remote_prefix(remotes.iter().flatten(), name) else {
        // A `refs/remotes/<x>/…` ref whose `<x>` is not a configured remote is
        // not something we can set an upstream from.
        return Ok(HeadTarget::Detached);
    };
    // A non-symbolic `refs/remotes/<remote>/HEAD` can be created by hand, and
    // `HEAD` is not a name a branch may have.
    if local == "HEAD" {
        return Ok(HeadTarget::Detached);
    }

    let existing = format!("refs/heads/{local}");
    if repo.find_reference(&existing).is_ok() {
        // git's DWIM: a local branch of that name is already here, so switch to
        // it as it stands rather than resetting it to the remote tip.
        return Ok(HeadTarget::Existing(existing));
    }
    Ok(HeadTarget::Track {
        local,
        upstream: name.to_string(),
        commit: remote_ref.peel_to_commit()?.id(),
    })
}

/// Blocking core of [`checkout_branch`]; opens the repo from `path`.
fn checkout_at(path: &std::path::Path, name: &str) -> AppResult<()> {
    let repo = git::open(path)?;
    let target = resolve_head_target(&repo, name)?;

    // Take the commit from the ref HEAD will end on, not from `name`: when a
    // local branch of the remote's name already exists we switch to *it*, so its
    // tip is what the working tree must match. Checking out the remote tip
    // instead would leave the difference sitting as a staged diff.
    let commit = match &target {
        HeadTarget::Existing(refname) => repo.find_reference(refname)?.peel_to_commit()?,
        HeadTarget::Track { commit, .. } => repo.find_commit(*commit)?,
        // Peels through annotated tags to the underlying commit.
        HeadTarget::Detached => repo.revparse_single(name)?.peel_to_commit()?,
    };

    // Do every ref and config write that can fail *before* the working tree is
    // touched, and undo them if one does: a directory/file ref conflict (an
    // existing `feature/nested` blocking `feature`) fails on `branch`, and a
    // held config lock or an ambiguous remote fails on `set_upstream`. Writing
    // the tree first would report those failures on a repo already switched over.
    if let HeadTarget::Track {
        local, upstream, ..
    } = &target
    {
        repo.branch(local, &commit, false)?;
        if let Err(e) = repo
            .find_branch(local, BranchType::Local)
            .and_then(|mut b| b.set_upstream(Some(upstream)))
        {
            delete_local_branch(&repo, local);
            return Err(e.into());
        }
    }

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    if let Err(e) = repo.checkout_tree(commit.as_object(), Some(&mut checkout)) {
        // The safe checkout refused (local edits would be lost). Drop the branch
        // we just made, so a refused checkout adds no refs of its own.
        if let HeadTarget::Track { local, .. } = &target {
            delete_local_branch(&repo, local);
        }
        return Err(e.into());
    }

    match target {
        HeadTarget::Existing(refname) => repo.set_head(&refname)?,
        HeadTarget::Track { local, .. } => repo.set_head(&format!("refs/heads/{local}"))?,
        HeadTarget::Detached => repo.set_head_detached(commit.id())?,
    }
    Ok(())
}

/// Best-effort removal of a local branch this run created, used to unwind a
/// checkout that could not be completed. A failure here is not worth reporting
/// over the error that triggered the unwind.
fn delete_local_branch(repo: &git2::Repository, local: &str) {
    if let Ok(mut branch) = repo.find_branch(local, BranchType::Local) {
        let _ = branch.delete();
    }
}

/// Create a new local branch and check it out. Mirrors `git checkout -b <name>
/// [<from_ref>]`.
///
/// The branch is created from `from_ref` (any branch / tag / commit) when given,
/// otherwise from the current `HEAD`, then checked out with the same
/// safe-checkout the manual switch uses. `checkout_tree` can rewrite the working
/// tree, so this runs on a blocking thread like `checkout_branch` (#131).
/// Local-only: the git2 build has networking disabled, so no remote branch is
/// created and nothing is pushed.
#[tauri::command]
pub async fn create_branch(
    state: State<'_, AppState>,
    repo_id: i64,
    name: String,
    from_ref: Option<String>,
) -> AppResult<()> {
    let path = crate::commands::history::repo_path(&state, repo_id)?;
    crate::commands::run_git_blocking(path, move |p| {
        create_branch_at(p, &name, from_ref.as_deref())
    })
    .await
}

/// Blocking core of [`create_branch`]; opens the repo from `path`.
fn create_branch_at(path: &std::path::Path, name: &str, from_ref: Option<&str>) -> AppResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Other("Branch name cannot be empty".into()));
    }
    // Validate against git's ref-name rules up front so the user gets a clear
    // message instead of a cryptic libgit2 error on `branch()`.
    if !git2::Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(AppError::Other(format!(
            "\"{name}\" is not a valid branch name"
        )));
    }

    let repo = git::open(path)?;

    if repo.find_branch(name, BranchType::Local).is_ok() {
        return Err(AppError::Other(format!(
            "A branch named \"{name}\" already exists"
        )));
    }

    // Resolve the starting point: an explicit ref, else current HEAD.
    let commit = repo
        .revparse_single(from_ref.unwrap_or("HEAD"))?
        .peel_to_commit()?;

    // force = false → errors if the branch somehow exists (already guarded above).
    repo.branch(name, &commit, false)?;

    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe();
    repo.checkout_tree(commit.as_object(), Some(&mut checkout))?;
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(())
}

/// Scan a directory for git repos, flagging which are already registered.
#[tauri::command]
pub fn discover_repos(
    state: State<AppState>,
    root: String,
    max_depth: Option<usize>,
) -> AppResult<Vec<DiscoveredRepo>> {
    let conn = lock(&state)?;
    // An explicit `max_depth` (from a deeper manual scan) wins; otherwise fall
    // back to the configured discovery depth. The prune list always applies.
    let (depth, prune) = discovery_opts(&conn);
    let found = git::discover(&PathBuf::from(&root), max_depth.unwrap_or(depth), &prune);

    found
        .into_iter()
        // The manual picker offers git repos only; folder auto-inclusion is a
        // folder-sync feature, not part of this one-off scan.
        .filter(|d| d.is_git_repo)
        .map(|d| {
            let canonical = d
                .path
                .canonicalize()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| d.path.display().to_string());
            let already_registered: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM repos WHERE path = ?1)",
                [&canonical],
                |r| r.get(0),
            )?;
            Ok(DiscoveredRepo {
                path: canonical,
                name: d.name,
                default_branch: d.default_branch,
                already_registered,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use std::path::Path;

    /// Commit a file so the repo has a HEAD to diff against.
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

    #[test]
    fn detects_dirty_working_trees() {
        let root = std::env::temp_dir().join("gamut_dirty_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        commit_file(&repo, "a.txt", "hello\n");

        // Clean working tree.
        assert!(!has_uncommitted_changes(&repo), "clean tree is not dirty");

        // Untracked file.
        std::fs::write(root.join("untracked.txt"), "new\n").unwrap();
        assert!(has_uncommitted_changes(&repo), "untracked file is dirty");
        std::fs::remove_file(root.join("untracked.txt")).unwrap();
        assert!(!has_uncommitted_changes(&repo), "back to clean");

        // Unstaged modification.
        std::fs::write(root.join("a.txt"), "hello world\n").unwrap();
        assert!(has_uncommitted_changes(&repo), "modified file is dirty");

        // Stage it — still dirty (staged change).
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        assert!(has_uncommitted_changes(&repo), "staged change is dirty");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creates_and_checks_out_a_branch() {
        let root = std::env::temp_dir().join(format!("gamut_create_branch_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = Repository::init(&root).unwrap();
        commit_file(&repo, "a.txt", "hello\n");

        // Default base is HEAD; the new branch becomes current.
        create_branch_at(&root, "feature-x", None).unwrap();
        let repo = Repository::open(&root).unwrap();
        assert_eq!(git::current_branch(&repo).as_deref(), Some("feature-x"));

        // Duplicate, invalid, and blank names are rejected with an error.
        assert!(
            create_branch_at(&root, "feature-x", None).is_err(),
            "duplicate"
        );
        assert!(create_branch_at(&root, "bad name", None).is_err(), "space");
        assert!(create_branch_at(&root, "  ", None).is_err(), "blank");

        // An explicit source ref bases the branch on that ref instead of HEAD.
        create_branch_at(&root, "feature-y", Some("feature-x")).unwrap();
        let repo = Repository::open(&root).unwrap();
        assert_eq!(git::current_branch(&repo).as_deref(), Some("feature-y"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Minimal schema for exercising folder sync without the full migration runner.
    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE repos (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 path TEXT NOT NULL UNIQUE,
                 name TEXT NOT NULL,
                 default_branch TEXT,
                 is_git_repo INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE groups (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL,
                 is_default INTEGER NOT NULL DEFAULT 0,
                 last_scan_at TEXT
             );
             CREATE TABLE repo_groups (
                 repo_id INTEGER NOT NULL,
                 group_id INTEGER NOT NULL,
                 PRIMARY KEY (repo_id, group_id)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn folder_sync_adds_repos_once_and_is_idempotent() {
        let root = std::env::temp_dir().join("gamut_sync_test");
        let _ = std::fs::remove_dir_all(&root);
        Repository::init(root.join("a")).unwrap();
        Repository::init(root.join("sub/b")).unwrap();
        Repository::init(root.join("node_modules/c")).unwrap(); // pruned

        let conn = test_conn();
        conn.execute("INSERT INTO groups (id, name) VALUES (1, 'G')", [])
            .unwrap();

        let folder = root.to_string_lossy().to_string();
        let added = sync_folder_group(&conn, 1, &folder).unwrap();
        assert_eq!(
            added, 3,
            "the synced root, a, and b added; sub is a container, node_modules pruned"
        );

        // The bound root is registered as a browsable non-git folder entry (the
        // only non-git entry here, since a and b are repos and sub is omitted).
        let non_git: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repos WHERE is_git_repo = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            non_git, 1,
            "synced root is registered as a non-git folder entry"
        );

        // Re-running is add-only: nothing new, no duplicates.
        let again = sync_folder_group(&conn, 1, &folder).unwrap();
        assert_eq!(again, 0, "second scan adds nothing");
        let members: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_groups WHERE group_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 3);

        // last_scan_at is stamped.
        let stamped: Option<String> = conn
            .query_row("SELECT last_scan_at FROM groups WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(stamped.is_some());

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn register_path_records_non_git_folder() {
        let root = std::env::temp_dir().join("gamut_non_git_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let conn = test_conn();

        // A plain folder (not a git repo) registers as a non-git entry instead
        // of erroring on NotARepo.
        let (id, inserted) = register_path(&conn, &root).unwrap();
        assert!(inserted, "new folder is inserted");
        let is_git: i64 = conn
            .query_row("SELECT is_git_repo FROM repos WHERE id = ?1", [id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(is_git, 0, "plain folder is flagged non-git");

        // A real git repo registers as a git entry.
        let repo_dir = root.join("real");
        Repository::init(&repo_dir).unwrap();
        let (gid, _) = register_path(&conn, &repo_dir).unwrap();
        let is_git: i64 = conn
            .query_row("SELECT is_git_repo FROM repos WHERE id = ?1", [gid], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(is_git, 1, "git repo is flagged git");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn register_path_rejects_files() {
        let root = std::env::temp_dir().join("gamut_reject_file_test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("notes.md");
        std::fs::write(&file, "hello").unwrap();

        let conn = test_conn();

        // A file must not register as a phantom "folder" row.
        let err = register_path(&conn, &file).unwrap_err();
        assert!(
            matches!(err, AppError::NotADirectory(_)),
            "expected NotADirectory, got: {err:?}"
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "no row is inserted for a file");

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn default_group_sync_registers_without_membership() {
        let root = std::env::temp_dir().join("gamut_default_sync_test");
        let _ = std::fs::remove_dir_all(&root);
        Repository::init(root.join("a")).unwrap();
        Repository::init(root.join("b")).unwrap();

        let conn = test_conn();
        conn.execute(
            "INSERT INTO groups (id, name, is_default) VALUES (1, 'Default', 1)",
            [],
        )
        .unwrap();

        let folder = root.to_string_lossy().to_string();
        let added = sync_folder_group(&conn, 1, &folder).unwrap();
        assert_eq!(added, 3, "both repos plus the synced root newly registered");

        // Repos (and the synced root folder) are registered...
        let repos: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(repos, 3);
        // ...but the default group never gets explicit memberships (they show
        // as ungrouped instead).
        let members: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_groups WHERE group_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(members, 0);

        // Re-running surfaces nothing new.
        assert_eq!(sync_folder_group(&conn, 1, &folder).unwrap(), 0);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// Dedicated connection for the `remove_repos` tests below: unlike
    /// `test_conn()` above (a minimal schema with no FKs, used by the
    /// folder-sync tests), this one enables `foreign_keys` and includes
    /// `repo_tags`/`repo_groups` so the cascade this feature depends on is
    /// actually exercised. Kept separate rather than retrofitting FKs onto
    /// `test_conn()`, which would perturb its unrelated tests.
    fn removal_test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute_batch(
            "CREATE TABLE repos (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 path TEXT NOT NULL UNIQUE,
                 name TEXT NOT NULL,
                 is_git_repo INTEGER NOT NULL DEFAULT 1
             );
             CREATE TABLE tags (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL UNIQUE
             );
             CREATE TABLE groups (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 name TEXT NOT NULL
             );
             CREATE TABLE repo_tags (
                 repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                 tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                 PRIMARY KEY (repo_id, tag_id)
             );
             CREATE TABLE repo_groups (
                 repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
                 group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
                 PRIMARY KEY (repo_id, group_id)
             );",
        )
        .unwrap();
        conn
    }

    #[test]
    fn remove_repos_deletes_every_listed_id_and_leaves_others_intact() {
        let conn = removal_test_conn();
        conn.execute_batch(
            "INSERT INTO repos (id, path, name) VALUES
                 (1, '/a', 'a'), (2, '/b', 'b'), (3, '/c', 'c');",
        )
        .unwrap();

        delete_repos(&conn, &[1, 3]).unwrap();

        let remaining: Vec<i64> = conn
            .prepare("SELECT id FROM repos ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(remaining, vec![2], "only the unlisted repo survives");
    }

    #[test]
    fn remove_repos_cascades_repo_tags_and_repo_groups() {
        let conn = removal_test_conn();
        conn.execute_batch(
            "INSERT INTO repos (id, path, name) VALUES (1, '/a', 'a'), (2, '/b', 'b');
             INSERT INTO tags (id, name) VALUES (1, 't');
             INSERT INTO groups (id, name) VALUES (1, 'g');
             INSERT INTO repo_tags (repo_id, tag_id) VALUES (1, 1), (2, 1);
             INSERT INTO repo_groups (repo_id, group_id) VALUES (1, 1), (2, 1);",
        )
        .unwrap();

        delete_repos(&conn, &[1]).unwrap();

        let tag_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_tags WHERE repo_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tag_rows, 0, "repo_tags cascades for the removed repo");
        let group_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_groups WHERE repo_id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(group_rows, 0, "repo_groups cascades for the removed repo");

        // The surviving repo's memberships are untouched.
        let survivor_tags: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM repo_tags WHERE repo_id = 2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            survivor_tags, 1,
            "the surviving repo's tag membership stays"
        );
    }

    #[test]
    fn remove_repos_is_a_no_op_for_empty_and_tolerates_unknown_ids() {
        let conn = removal_test_conn();
        conn.execute(
            "INSERT INTO repos (id, path, name) VALUES (1, '/a', 'a')",
            [],
        )
        .unwrap();

        delete_repos(&conn, &[]).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "empty id list touches nothing");

        delete_repos(&conn, &[404]).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM repos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "unknown id is tolerated, not an error");
    }

    /// The auto-pull opt-in (#299) is per repo: flipping one repo's flag must not
    /// enrol its neighbours, since the flag is what licenses a background write to
    /// that repo's working tree. Also pins the read path (`list_repos_from_conn`)
    /// and the default.
    #[test]
    fn set_auto_pull_writes_exactly_one_repo() {
        let root = std::env::temp_dir().join(format!("gamut_auto_pull_db_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // The real migration runner, so the column under test is the shipped one.
        let conn = crate::db::open(root.join("gamut.db")).unwrap();
        conn.execute(
            "INSERT INTO repos (id, path, name) VALUES (1, '/repos/a', 'a'), (2, '/repos/b', 'b')",
            [],
        )
        .unwrap();

        let flags = |conn: &Connection| -> Vec<(i64, bool)> {
            list_repos_from_conn(conn)
                .unwrap()
                .into_iter()
                .map(|r| (r.id, r.auto_pull))
                .collect()
        };

        assert_eq!(
            flags(&conn),
            vec![(1, false), (2, false)],
            "every repo starts opted out"
        );

        set_auto_pull(&conn, 1, true).unwrap();
        assert_eq!(
            flags(&conn),
            vec![(1, true), (2, false)],
            "only the named repo is opted in"
        );

        set_auto_pull(&conn, 1, false).unwrap();
        assert_eq!(flags(&conn), vec![(1, false), (2, false)], "and back off");

        // An unknown id is a no-op, not an error — the row may have been removed
        // between the menu click and the write.
        assert!(set_auto_pull(&conn, 404, true).is_ok());
        assert_eq!(flags(&conn), vec![(1, false), (2, false)]);

        drop(conn);
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---------------------------------------------------------------------
    // checkout_at / resolve_head_target / strip_remote_prefix (#305)
    // ---------------------------------------------------------------------

    /// Initialise a fresh repo at `root` with one commit, with HEAD landing on
    /// `branch_name` regardless of the environment's default init branch (which
    /// varies by git version/global config) — so fixtures never depend on it.
    fn init_repo_on(root: &Path, branch_name: &str) -> Repository {
        let repo = Repository::init(root).unwrap();
        commit_file(&repo, "a.txt", "hello\n");
        let current = git::current_branch(&repo).unwrap();
        if current != branch_name {
            repo.find_branch(&current, BranchType::Local)
                .unwrap()
                .rename(branch_name, false)
                .unwrap();
            repo.set_head(&format!("refs/heads/{branch_name}")).unwrap();
        }
        repo
    }

    /// Convenience wrapper of [`init_repo_on`] for the common case: a fresh
    /// repo with one commit, HEAD on `main`.
    fn init_repo(root: &Path) -> Repository {
        init_repo_on(root, "main")
    }

    /// Build a new commit on top of `parent_oid`, writing `name` = `contents`,
    /// without touching the index, HEAD, or working tree — used to create a
    /// commit on a ref other than the one currently checked out (e.g. a
    /// remote-tracking ref that should differ from the local tip).
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

    /// A1/A2/A3: checking out `origin/feature` when there is no local `feature`
    /// creates a local branch at the remote ref's commit, leaves the working
    /// tree/index clean, sets up its upstream, and attaches HEAD to it.
    #[test]
    fn checkout_remote_branch_creates_local_tracking_branch() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a1_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        let oid_feature = commit_on(&repo, oid_a, "a.txt", "feature content\n");
        repo.reference("refs/remotes/origin/feature", oid_feature, true, "test")
            .unwrap();

        checkout_at(&root, "origin/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        let local = repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(
            local.get().target(),
            Some(oid_feature),
            "local branch lands on the remote ref's commit"
        );
        assert!(
            repo.statuses(None).unwrap().is_empty(),
            "working tree/index left clean after checkout"
        );
        let config = repo.config().unwrap();
        assert_eq!(
            config.get_string("branch.feature.remote").unwrap(),
            "origin"
        );
        assert_eq!(
            config.get_string("branch.feature.merge").unwrap(),
            "refs/heads/feature"
        );
        assert!(!repo.head_detached().unwrap());
        assert_eq!(git::current_branch(&repo).as_deref(), Some("feature"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A4: a nested remote branch name (`origin/feature/nested`) strips only the
    /// remote's own segment; the rest of the name — including its slash — stays
    /// intact as the local branch name and the upstream merge ref.
    #[test]
    fn checkout_remote_branch_nested_name_strips_only_remote_prefix() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a4_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.reference("refs/remotes/origin/feature/nested", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "origin/feature/nested").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo
            .find_branch("feature/nested", BranchType::Local)
            .is_ok());
        let config = repo.config().unwrap();
        assert_eq!(
            config.get_string("branch.feature/nested.merge").unwrap(),
            "refs/heads/feature/nested"
        );
        assert_eq!(
            git::current_branch(&repo).as_deref(),
            Some("feature/nested")
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A5a/A6: when a local branch of the remote's name already exists, git's
    /// DWIM switches to it as it stands — checking out `origin/feature` does not
    /// reset it to the remote tip, and it keeps having no upstream. The working
    /// tree ends up matching the *local* branch's own commit, not the remote's,
    /// and the tree/index stay clean.
    #[test]
    fn checkout_existing_local_branch_keeps_its_own_commit_and_upstream() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a5a_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let commit_a = repo.find_commit(oid_a).unwrap();
        // Local "feature" at commit A, deliberately with no upstream.
        repo.branch("feature", &commit_a, false).unwrap();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        // origin/feature points somewhere else entirely (commit B).
        let oid_b = commit_on(&repo, oid_a, "a.txt", "commit B content\n");
        repo.reference("refs/remotes/origin/feature", oid_b, true, "test")
            .unwrap();

        checkout_at(&root, "origin/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(!repo.head_detached().unwrap());
        assert_eq!(git::current_branch(&repo).as_deref(), Some("feature"));
        let local = repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(
            local.get().target(),
            Some(oid_a),
            "existing local branch is not moved to the remote tip"
        );
        assert!(
            repo.config()
                .unwrap()
                .get_string("branch.feature.remote")
                .is_err(),
            "no upstream was set"
        );
        // A6: the working tree holds commit A's content, not commit B's, and the
        // tree/index are clean against the branch actually checked out.
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "hello\n"
        );
        assert!(repo.statuses(None).unwrap().is_empty());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A5b: an existing local branch tracking a *different* remote keeps that
    /// upstream — checking out `origin/feature` must not rewrite
    /// `branch.feature.remote` from `upstream` to `origin`.
    #[test]
    fn checkout_existing_local_branch_does_not_rewrite_existing_upstream() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a5b_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let commit_a = repo.find_commit(oid_a).unwrap();
        repo.branch("feature", &commit_a, false).unwrap();
        repo.remote("origin", "https://example.com/origin.git")
            .unwrap();
        repo.remote("upstream", "https://example.com/upstream.git")
            .unwrap();
        repo.reference("refs/remotes/upstream/feature", oid_a, true, "test")
            .unwrap();
        repo.find_branch("feature", BranchType::Local)
            .unwrap()
            .set_upstream(Some("upstream/feature"))
            .unwrap();
        repo.reference("refs/remotes/origin/feature", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "origin/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert_eq!(
            repo.config()
                .unwrap()
                .get_string("branch.feature.remote")
                .unwrap(),
            "upstream",
            "existing upstream is left alone, not rewritten to origin"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A7a: checking out a lightweight tag detaches HEAD at the tag's commit.
    #[test]
    fn checkout_lightweight_tag_detaches_at_tag_commit() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a7a_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let obj = repo.find_object(oid_a, None).unwrap();
        repo.tag_lightweight("v1", &obj, false).unwrap();

        checkout_at(&root, "v1").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), oid_a);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A7b: checking out an annotated tag detaches HEAD at the *peeled commit*,
    /// not the tag object's own id.
    #[test]
    fn checkout_annotated_tag_detaches_at_peeled_commit() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a7b_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let obj = repo.find_object(oid_a, None).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let tag_oid = repo.tag("v2", &obj, &sig, "annotated", false).unwrap();
        assert_ne!(tag_oid, oid_a, "sanity: the tag object has its own id");

        checkout_at(&root, "v2").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), oid_a);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A8: checking out a full sha detaches HEAD at that commit.
    #[test]
    fn checkout_raw_sha_detaches() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a8_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();

        checkout_at(&root, &oid_a.to_string()).unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), oid_a);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A9: `origin/HEAD` is symbolic (points at another ref rather than naming
    /// its own branch) — checking it out detaches HEAD and creates no local
    /// branch literally called `HEAD`.
    #[test]
    fn checkout_symbolic_origin_head_detaches_without_creating_head_branch() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a9_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.reference("refs/remotes/origin/main", oid_a, true, "test")
            .unwrap();
        repo.reference_symbolic(
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
            true,
            "test",
        )
        .unwrap();

        checkout_at(&root, "origin/HEAD").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert!(repo.find_branch("HEAD", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A `refs/remotes/<remote>/HEAD` that is a direct ref rather than a
    /// symbolic one skips the symbolic-ref check, so the name guard is the only
    /// thing keeping a branch literally called `HEAD` from being created.
    #[test]
    fn checkout_direct_origin_head_ref_detaches_without_creating_head_branch() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a9b_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.reference("refs/remotes/origin/HEAD", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "origin/HEAD").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert!(repo.find_branch("HEAD", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A10: a plain local branch just attaches HEAD; its (absent) upstream
    /// config is left untouched.
    #[test]
    fn checkout_plain_local_branch_attaches_without_touching_upstream() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a10_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let commit_a = repo.find_commit(oid_a).unwrap();
        repo.branch("feature", &commit_a, false).unwrap();

        checkout_at(&root, "feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(!repo.head_detached().unwrap());
        assert_eq!(git::current_branch(&repo).as_deref(), Some("feature"));
        assert!(
            repo.config()
                .unwrap()
                .get_string("branch.feature.remote")
                .is_err(),
            "no upstream config was introduced"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A11: a local branch can be *literally* named `origin/x` (a directory
    /// component, not a remote-prefix). Local-branch precedence in
    /// `resolve_head_target` means checking out `origin/x` attaches to that
    /// literal branch at its own commit, ignoring the differently-pointed
    /// `refs/remotes/origin/x`, and never creates a branch called `x`.
    #[test]
    fn checkout_prefers_literal_local_branch_named_like_a_remote_ref() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a11_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let commit_a = repo.find_commit(oid_a).unwrap();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.branch("origin/x", &commit_a, false).unwrap();
        let oid_b = commit_on(&repo, oid_a, "a.txt", "commit B content\n");
        repo.reference("refs/remotes/origin/x", oid_b, true, "test")
            .unwrap();

        checkout_at(&root, "origin/x").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(!repo.head_detached().unwrap());
        let local = repo.find_branch("origin/x", BranchType::Local).unwrap();
        assert_eq!(
            local.get().target(),
            Some(oid_a),
            "attaches to the literal branch's own commit, not the remote ref's"
        );
        assert!(repo.find_branch("x", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A12: a tag and a remote-tracking ref can share a name — tags outrank
    /// remotes, so checking out `origin/x` detaches at the tag's commit and
    /// creates no local branch `x`.
    #[test]
    fn checkout_prefers_tag_over_remote_branch_of_same_name() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a12_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        let obj = repo.find_object(oid_a, None).unwrap();
        repo.tag_lightweight("origin/x", &obj, false).unwrap();
        let oid_b = commit_on(&repo, oid_a, "a.txt", "commit B content\n");
        repo.reference("refs/remotes/origin/x", oid_b, true, "test")
            .unwrap();

        checkout_at(&root, "origin/x").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id(), oid_a);
        assert!(repo.find_branch("x", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A13a: `refs/remotes/notaremote/feature` exists but `notaremote` is not a
    /// configured remote — there's no remote to attribute an upstream to, so
    /// this just detaches like any other unrecognised ref shape.
    #[test]
    fn checkout_remote_ref_under_unconfigured_remote_detaches() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a13a_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.reference("refs/remotes/notaremote/feature", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "notaremote/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.head_detached().unwrap());
        assert!(repo.find_branch("feature", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A13b: `notaremote` *is* configured but no such ref exists — there's
    /// nothing to check out at all, so `checkout_at` errors and HEAD is left
    /// exactly where it was.
    #[test]
    fn checkout_unknown_ref_under_configured_remote_errors() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a13b_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        repo.remote("notaremote", "https://example.com/x.git")
            .unwrap();
        let head_before = repo.head().unwrap().target();

        assert!(checkout_at(&root, "notaremote/feature").is_err());

        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.head().unwrap().target(), head_before);

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A14: two remotes both carry a `feature` branch — checking out
    /// `upstream/feature` attributes the new local branch to `upstream`, not
    /// `origin`.
    #[test]
    fn checkout_selects_the_named_remote_when_multiple_carry_the_branch() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a14_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/origin.git")
            .unwrap();
        repo.remote("upstream", "https://example.com/upstream.git")
            .unwrap();
        repo.reference("refs/remotes/origin/feature", oid_a, true, "test")
            .unwrap();
        repo.reference("refs/remotes/upstream/feature", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "upstream/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        let local = repo.find_branch("feature", BranchType::Local).unwrap();
        assert_eq!(local.get().target(), Some(oid_a));
        assert_eq!(
            repo.config()
                .unwrap()
                .get_string("branch.feature.remote")
                .unwrap(),
            "upstream"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A15: with remotes `origin` and `origin2` both configured, a ref under
    /// `origin2` strips the whole remote name, landing on local branch
    /// `feature` — never `2/feature`. (The longest-match tie-break between two
    /// remotes that both match is covered by `strip_remote_prefix_rules`.)
    #[test]
    fn checkout_strips_whole_remote_name_not_just_first_segment() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a15_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/origin.git")
            .unwrap();
        repo.remote("origin2", "https://example.com/origin2.git")
            .unwrap();
        repo.reference("refs/remotes/origin2/feature", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "origin2/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(repo.find_branch("feature", BranchType::Local).is_ok());
        assert!(repo.find_branch("2/feature", BranchType::Local).is_err());
        assert_eq!(
            repo.config()
                .unwrap()
                .get_string("branch.feature.remote")
                .unwrap(),
            "origin2"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A16: only `refs/remotes/origin/main` exists — no literal `refs/remotes/main`
    /// (which is what `resolve_head_target` and libgit2's own ref-DWIM look for
    /// on a bare name). Real `git checkout main` special-cases "exactly one
    /// remote has this branch" at a layer above plain ref resolution; that
    /// DWIM is deliberately out of scope for #305, which only changed the
    /// explicit `origin/feature` shape. So a bare `main` here still falls
    /// through to `revparse_single`, which — unlike the assumption that this
    /// legacy path silently detaches — actually errors ("revspec not found"),
    /// exactly as it did before #305. This test pins that: no local `main` is
    /// ever created, and HEAD is left exactly where it was.
    #[test]
    fn checkout_bare_name_matching_only_remote_tracking_branch_still_errors() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a16_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo_on(&root, "trunk");
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.reference("refs/remotes/origin/main", oid_a, true, "test")
            .unwrap();
        let head_before = repo.head().unwrap().target();

        assert!(checkout_at(&root, "main").is_err());

        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.head().unwrap().target(), head_before);
        assert!(repo.find_branch("main", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A17: checking out the same remote branch twice in a row is idempotent —
    /// the second call is the `HeadTarget::Existing` path, HEAD stays attached
    /// to the one `feature` branch, and no duplicate gets created.
    #[test]
    fn checkout_remote_branch_twice_is_idempotent() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a17_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.reference("refs/remotes/origin/feature", oid_a, true, "test")
            .unwrap();

        checkout_at(&root, "origin/feature").unwrap();
        checkout_at(&root, "origin/feature").unwrap();

        let repo = Repository::open(&root).unwrap();
        assert!(!repo.head_detached().unwrap());
        assert_eq!(git::current_branch(&repo).as_deref(), Some("feature"));
        let mut count = 0;
        for b in repo.branches(Some(BranchType::Local)).unwrap() {
            let (branch, _) = b.unwrap();
            if branch.name().unwrap() == Some("feature") {
                count += 1;
            }
        }
        assert_eq!(count, 1, "no duplicate local branch was created");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A18: an existing local branch `feature/nested` occupies the
    /// `refs/heads/feature` path as a directory component, so creating
    /// `refs/heads/feature` for the incoming remote branch fails. `checkout_at`
    /// must surface that error before touching the working tree, leaving HEAD
    /// untouched and no local `feature` branch behind.
    #[test]
    fn checkout_remote_branch_errors_when_local_branch_path_conflicts() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a18_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        let commit_a = repo.find_commit(oid_a).unwrap();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        repo.branch("feature/nested", &commit_a, false).unwrap();
        repo.reference("refs/remotes/origin/feature", oid_a, true, "test")
            .unwrap();
        let head_before = repo.head().unwrap().target();

        assert!(checkout_at(&root, "origin/feature").is_err());

        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.head().unwrap().target(), head_before);
        assert!(repo.find_branch("feature", BranchType::Local).is_err());

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A19: an uncommitted local edit conflicts with a file that also differs
    /// between HEAD and the remote tip — the safe checkout must refuse rather
    /// than clobber it, `checkout_at` returns `Err`, HEAD is untouched, and the
    /// branch it tentatively created is rolled back rather than left as an
    /// orphan.
    #[test]
    fn checkout_remote_branch_refuses_when_local_edit_would_be_lost() {
        let root = std::env::temp_dir().join(format!("gamut_checkout_a19_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let repo = init_repo(&root);
        let oid_a = repo.head().unwrap().peel_to_commit().unwrap().id();
        repo.remote("origin", "https://example.com/x.git").unwrap();
        let oid_remote = commit_on(&repo, oid_a, "a.txt", "remote version\n");
        repo.reference("refs/remotes/origin/feature", oid_remote, true, "test")
            .unwrap();
        // Uncommitted edit that differs from both HEAD and the remote tip.
        std::fs::write(root.join("a.txt"), "local edit\n").unwrap();
        let head_before = repo.head().unwrap().target();

        assert!(checkout_at(&root, "origin/feature").is_err());

        let repo = Repository::open(&root).unwrap();
        assert_eq!(repo.head().unwrap().target(), head_before);
        assert!(repo.find_branch("feature", BranchType::Local).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "local edit\n",
            "the refused checkout left the local edit in place"
        );
        // The upstream is written before the tree, so unwinding has to take the
        // tracking config with it rather than stranding it for the next branch
        // that happens to be called `feature`.
        assert!(
            repo.config()
                .unwrap()
                .get_string("branch.feature.remote")
                .is_err(),
            "the unwound branch left no tracking config behind"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A20: `strip_remote_prefix` on its own — the longest-matching remote
    /// wins, inner slashes in the branch name are preserved, and a name that
    /// doesn't belong to any configured remote (or has nothing left over) is
    /// rejected.
    #[test]
    fn strip_remote_prefix_rules() {
        assert_eq!(
            strip_remote_prefix(["origin"], "origin/feature"),
            Some("feature".to_string())
        );
        assert_eq!(
            strip_remote_prefix(["origin"], "origin/feature/nested"),
            Some("feature/nested".to_string())
        );
        assert_eq!(
            strip_remote_prefix(["origin", "origin2"], "origin2/feature"),
            Some("feature".to_string())
        );
        assert_eq!(
            strip_remote_prefix(["origin", "origin/mirror"], "origin/mirror/feat"),
            Some("feat".to_string()),
            "longest matching remote wins"
        );
        assert_eq!(strip_remote_prefix(["origin"], "other/feature"), None);
        assert_eq!(strip_remote_prefix(["origin"], "origin/"), None);
        assert_eq!(strip_remote_prefix(["origin"], "origin"), None);
    }
}
