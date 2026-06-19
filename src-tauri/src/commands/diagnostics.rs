//! In-app diagnostics (issue #90). A rolling, in-memory log of how long the
//! heavy git operations take, plus a snapshot of the app's current shape (repo
//! and group counts, watched paths, concurrency limits). Exposed so a user who
//! hits a freeze or slowdown can copy or save a bundle for us to read, instead
//! of needing a system-level spindump.

use std::collections::VecDeque;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// How many timings the rolling log keeps before dropping the oldest.
pub const OP_LOG_CAP: usize = 500;

/// How many of the most recent timings the snapshot includes verbatim.
const RECENT_OPS: usize = 50;

/// One recorded operation timing.
#[derive(Clone, Serialize)]
pub struct OpTiming {
    /// Logical operation name, e.g. `git_worktree_status`.
    pub op: String,
    /// The repo it ran against, when applicable.
    pub repo_id: Option<i64>,
    pub duration_ms: u64,
    pub ok: bool,
    /// Wall-clock finish time, milliseconds since the Unix epoch.
    pub at_ms: u64,
    /// Optional context — an error message, or a count like "47 repos".
    pub detail: Option<String>,
}

impl OpTiming {
    /// Build a timing for an op that started at `start` and just finished.
    pub fn finished(
        op: &str,
        repo_id: Option<i64>,
        start: Instant,
        ok: bool,
        detail: Option<String>,
    ) -> Self {
        Self {
            op: op.to_string(),
            repo_id,
            duration_ms: start.elapsed().as_millis() as u64,
            ok,
            at_ms: now_ms(),
            detail,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append a timing to the rolling log, trimming to [`OP_LOG_CAP`]. Never fails
/// loudly — diagnostics must not perturb the operation they measure.
pub fn record(state: &AppState, timing: OpTiming) {
    if let Ok(mut log) = state.op_log.lock() {
        log.push_back(timing);
        while log.len() > OP_LOG_CAP {
            log.pop_front();
        }
    }
}

/// Aggregate timing for one operation name.
#[derive(Serialize)]
pub struct OpStat {
    pub op: String,
    pub count: usize,
    pub fail_count: usize,
    pub max_ms: u64,
    pub avg_ms: u64,
}

/// A point-in-time diagnostics bundle.
#[derive(Serialize)]
pub struct Diagnostics {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub generated_at_ms: u64,
    pub repo_count: usize,
    pub group_count: usize,
    pub watched_path_count: usize,
    /// Per-operation aggregates over the rolling log, slowest first.
    pub op_stats: Vec<OpStat>,
    /// The most recent timings, newest last.
    pub recent_ops: Vec<OpTiming>,
}

fn count(state: &AppState, sql: &str) -> usize {
    state
        .db
        .lock()
        .ok()
        .and_then(|conn| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).ok())
        .unwrap_or(0) as usize
}

fn op_stats(log: &VecDeque<OpTiming>) -> Vec<OpStat> {
    use std::collections::BTreeMap;
    // (count, fail_count, max_ms, total_ms) keyed by op name.
    let mut acc: BTreeMap<&str, (usize, usize, u64, u64)> = BTreeMap::new();
    for t in log {
        let e = acc.entry(t.op.as_str()).or_insert((0, 0, 0, 0));
        e.0 += 1;
        if !t.ok {
            e.1 += 1;
        }
        e.2 = e.2.max(t.duration_ms);
        e.3 += t.duration_ms;
    }
    let mut stats: Vec<OpStat> = acc
        .into_iter()
        .map(|(op, (count, fail_count, max_ms, total_ms))| OpStat {
            op: op.to_string(),
            count,
            fail_count,
            max_ms,
            avg_ms: if count > 0 {
                total_ms / count as u64
            } else {
                0
            },
        })
        .collect();
    // Slowest (by max) first — that's what a hang investigation wants.
    stats.sort_by_key(|s| std::cmp::Reverse(s.max_ms));
    stats
}

/// Build the current diagnostics bundle.
pub fn snapshot(app: &AppHandle, state: &AppState) -> Diagnostics {
    let watched_path_count = state
        .watcher
        .lock()
        .ok()
        .and_then(|w| w.as_ref().map(|w| w.watched_count()))
        .unwrap_or(0);

    let log = state.op_log.lock().map(|l| l.clone()).unwrap_or_default();
    let recent_ops: Vec<OpTiming> = log.iter().rev().take(RECENT_OPS).rev().cloned().collect();

    Diagnostics {
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        generated_at_ms: now_ms(),
        repo_count: count(state, "SELECT COUNT(*) FROM repos"),
        group_count: count(state, "SELECT COUNT(*) FROM groups"),
        watched_path_count,
        op_stats: op_stats(&log),
        recent_ops,
    }
}

/// Current diagnostics, for the in-app panel and clipboard copy.
#[tauri::command]
pub fn diagnostics_snapshot(app: AppHandle, state: State<AppState>) -> AppResult<Diagnostics> {
    Ok(snapshot(&app, &state))
}

/// Write a pretty-printed diagnostics bundle to `path` (chosen via the OS save
/// dialog on the frontend). Returns nothing on success.
#[tauri::command]
pub fn diagnostics_write(app: AppHandle, state: State<AppState>, path: String) -> AppResult<()> {
    let bundle = snapshot(&app, &state);
    let json = serde_json::to_string_pretty(&bundle)
        .map_err(|e| AppError::Other(format!("failed to serialize diagnostics: {e}")))?;
    std::fs::write(&path, json)?;
    Ok(())
}

/// Record a main-thread stall observed by the frontend watchdog. `gap_ms` is
/// how long the UI loop was blocked beyond its expected tick.
#[tauri::command]
pub fn diagnostics_record_stall(state: State<AppState>, gap_ms: u64) {
    record(
        &state,
        OpTiming {
            op: "ui_stall".to_string(),
            repo_id: None,
            duration_ms: gap_ms,
            ok: false,
            at_ms: now_ms(),
            detail: Some("frontend watchdog: UI loop blocked".to_string()),
        },
    );
}
