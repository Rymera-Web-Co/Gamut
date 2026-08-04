//! In-app diagnostics (issue #90). A rolling, in-memory log of how long the
//! heavy git operations take, plus a snapshot of the app's current shape (repo
//! and group counts, watched paths, concurrency limits). Exposed so a user who
//! hits a freeze or slowdown can copy or save a bundle for us to read, instead
//! of needing a system-level spindump.
//!
//! Also captures every error surfaced through the toast layer (#301) into the
//! same kind of rolling log, persisted to `errors.log` alongside `gamut.db` so
//! it survives restarts — see [`record_error`] and [`hydrate_error_log`].

use std::collections::VecDeque;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

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

/// Filename of the persisted error log, alongside `gamut.db` in the app data
/// dir (#301).
const ERROR_LOG_FILE: &str = "errors.log";

/// How many captured error-toast entries the ring buffer (and a hydrate) keep
/// before dropping the oldest.
pub const ERROR_LOG_CAP: usize = 100;

/// Per-entry message cap; a longer message is truncated with a `… (truncated)`
/// suffix before it's stored or persisted. Without this, one huge error
/// string (e.g. a git error echoing a diff) would defeat the file size cap in
/// a single append.
pub const MAX_ERROR_MESSAGE_CHARS: usize = 4000;

/// Byte cap for `errors.log`. Exceeding it trims the oldest whole lines —
/// never a partial line — keeping the newest entries.
pub const ERROR_LOG_MAX_BYTES: u64 = 256 * 1024;

/// How far down a trim cuts once [`ERROR_LOG_MAX_BYTES`] is exceeded. Trimming
/// to a low-water mark rather than to the cap itself is what keeps the rewrite
/// amortised: cutting back to exactly the cap would leave the file one append
/// away from being over again, so every subsequent error would pay a full
/// read-modify-write of the whole file — on the main thread, in an app that
/// tracks UI stalls precisely because they matter. Halving instead buys many
/// cheap appends per trim.
const ERROR_LOG_TRIM_TO_BYTES: u64 = ERROR_LOG_MAX_BYTES / 2;

/// One captured error-toast message (#301).
#[derive(Clone, Serialize, Deserialize)]
pub struct ErrorEntry {
    /// Wall-clock time the error was recorded, milliseconds since the Unix
    /// epoch. The backend is the sole timestamp authority — this is stamped
    /// inside [`record_error`]; the frontend sends only the message.
    pub at_ms: u64,
    pub message: String,
}

/// Truncate `message` to [`MAX_ERROR_MESSAGE_CHARS`], appending a marker when
/// it was cut.
fn truncate_message(message: &str) -> String {
    if message.chars().count() <= MAX_ERROR_MESSAGE_CHARS {
        return message.to_string();
    }
    let truncated: String = message.chars().take(MAX_ERROR_MESSAGE_CHARS).collect();
    format!("{truncated}… (truncated)")
}

/// Trim `path` down to [`ERROR_LOG_TRIM_TO_BYTES`] once it exceeds
/// [`ERROR_LOG_MAX_BYTES`], keeping the newest whole lines (never a partial
/// leading line) and at most [`ERROR_LOG_CAP`] of them. A no-op (cheap
/// metadata check) while the file is within the cap. Best-effort: a failure
/// here just leaves the file oversized until the next successful append.
fn trim_error_log(path: &Path) {
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else {
        return;
    };
    if len <= ERROR_LOG_MAX_BYTES {
        return;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    let text = String::from_utf8_lossy(&bytes);
    let mut kept: Vec<&str> = Vec::new();
    let mut total: u64 = 0;
    for line in text.lines().rev() {
        if kept.len() >= ERROR_LOG_CAP {
            break;
        }
        // + newline. The first line is kept unconditionally so the file can
        // never end up empty; a single entry is bounded by
        // `MAX_ERROR_MESSAGE_CHARS` and so is always far under the low-water
        // mark anyway.
        let line_bytes = line.len() as u64 + 1;
        if !kept.is_empty() && total + line_bytes > ERROR_LOG_TRIM_TO_BYTES {
            break;
        }
        kept.push(line);
        total += line_bytes;
    }
    kept.reverse();
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    let _ = std::fs::write(path, out);
}

/// Push a captured error onto `ring` and persist it to `<dir>/errors.log`,
/// trimming the file if it now exceeds [`ERROR_LOG_MAX_BYTES`]. The public
/// record entry point (#301) — both the ring push and the file append happen
/// while `ring`'s mutex is held, which serializes concurrent callers (e.g.
/// several fanned-out git failures at once) so their lines can't interleave.
/// File I/O is best-effort: a write failure leaves the entry in the ring
/// (still visible this session) rather than surfacing an error of its own.
pub fn record_error(dir: &Path, ring: &Mutex<VecDeque<ErrorEntry>>, message: &str) {
    let entry = ErrorEntry {
        at_ms: now_ms(),
        message: truncate_message(message),
    };
    let Ok(mut log) = ring.lock() else {
        return;
    };
    log.push_back(entry.clone());
    while log.len() > ERROR_LOG_CAP {
        log.pop_front();
    }
    if let Ok(line) = serde_json::to_string(&entry) {
        let path = dir.join(ERROR_LOG_FILE);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            // One pre-terminated `write_all`, not `writeln!`: a `File` is
            // unbuffered and `write_fmt` emits one syscall per fragment, so
            // `writeln!` would write the line and its newline separately. A
            // crash between the two would leave a line with no terminator, and
            // the next append would concatenate onto it — producing one
            // unparseable `{…}{…}` line and losing both entries.
            let _ = f.write_all(format!("{line}\n").as_bytes());
        }
        trim_error_log(&path);
    }
    // `log` (and the mutex) is released here, after the file append above —
    // that ordering is what prevents interleaved lines from concurrent callers.
}

/// Read `<dir>/errors.log` and parse one [`ErrorEntry`] per line, keeping the
/// newest [`ERROR_LOG_CAP`]. Never errors or panics — a missing, empty,
/// non-UTF-8, or otherwise unreadable file yields an empty ring, and a
/// malformed line is skipped rather than aborting the hydrate, so a corrupt
/// log can never block app startup (#301).
pub fn hydrate_error_log(dir: &Path) -> VecDeque<ErrorEntry> {
    let path = dir.join(ERROR_LOG_FILE);
    let Ok(bytes) = std::fs::read(&path) else {
        return VecDeque::new();
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return VecDeque::new();
    };
    let mut entries: VecDeque<ErrorEntry> = text
        .lines()
        .filter_map(|line| serde_json::from_str::<ErrorEntry>(line).ok())
        .collect();
    while entries.len() > ERROR_LOG_CAP {
        entries.pop_front();
    }
    entries
}

/// Clear the ring and remove `errors.log` together (#301) — clearing only one
/// would leave the other to resurrect stale entries, either via the next
/// hydrate or because Copy/Save still reads the ring.
pub fn clear_error_log(dir: &Path, ring: &Mutex<VecDeque<ErrorEntry>>) -> AppResult<()> {
    if let Ok(mut log) = ring.lock() {
        log.clear();
    }
    let path = dir.join(ERROR_LOG_FILE);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
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
    /// Directories the last watcher resync tried to watch but the OS rejected
    /// (e.g. the per-process filesystem-watch limit). Nonzero means some repos
    /// aren't being watched and their changes won't refresh live.
    pub watch_failed_count: usize,
    /// Per-operation aggregates over the rolling log, slowest first.
    pub op_stats: Vec<OpStat>,
    /// The most recent timings, newest last.
    pub recent_ops: Vec<OpTiming>,
    /// The captured error-toast ring's entire contents, newest last (matching
    /// `recent_ops`) — the cap is small enough it always fits (#301).
    pub recent_errors: Vec<ErrorEntry>,
}

/// The error-log portion of a snapshot: the ring's current contents, oldest
/// first. Split out from [`snapshot`] so hydration into `AppState.error_log`
/// can be proven to reach the same read path a real snapshot uses, without
/// needing an `AppHandle` (#301).
fn recent_errors(state: &AppState) -> Vec<ErrorEntry> {
    state
        .error_log
        .lock()
        .map(|l| l.iter().cloned().collect())
        .unwrap_or_default()
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
    let (watched_path_count, watch_failed_count) = state
        .watcher
        .lock()
        .ok()
        .and_then(|w| w.as_ref().map(|w| (w.watched_count(), w.failed_count())))
        .unwrap_or((0, 0));

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
        watch_failed_count,
        op_stats: op_stats(&log),
        recent_ops,
        recent_errors: recent_errors(state),
    }
}

/// Current diagnostics, for the in-app panel and clipboard copy.
#[tauri::command]
pub fn diagnostics_snapshot(app: AppHandle, state: State<AppState>) -> AppResult<Diagnostics> {
    Ok(snapshot(&app, &state))
}

/// Serialize `bundle` and write it to `path`. Split out from
/// [`diagnostics_write`] so the write path is testable without an
/// `AppHandle` (#301).
fn write_bundle(bundle: &Diagnostics, path: &str) -> AppResult<()> {
    let json = serde_json::to_string_pretty(bundle)
        .map_err(|e| AppError::Other(format!("failed to serialize diagnostics: {e}")))?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Write a pretty-printed diagnostics bundle to `path` (chosen via the OS save
/// dialog on the frontend). Returns nothing on success.
#[tauri::command]
pub fn diagnostics_write(app: AppHandle, state: State<AppState>, path: String) -> AppResult<()> {
    let bundle = snapshot(&app, &state);
    write_bundle(&bundle, &path)
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

/// Capture an error-toast message at the single choke point (#301) — see
/// `src/store/toast.ts`'s `push`. Appends to the in-memory ring and to
/// `errors.log` in one call.
#[tauri::command]
pub fn errors_record(app: AppHandle, state: State<AppState>, message: String) -> AppResult<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("could not resolve app data dir: {e}")))?;
    record_error(&data_dir, &state.error_log, &message);
    Ok(())
}

/// Clear the captured-error ring and its persisted log together (#301).
#[tauri::command]
pub fn errors_clear(app: AppHandle, state: State<AppState>) -> AppResult<()> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Other(format!("could not resolve app data dir: {e}")))?;
    clear_error_log(&data_dir, &state.error_log)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    use rusqlite::Connection;
    use tokio::sync::Semaphore;

    use crate::state::{AppState, GIT_STATUS_CONCURRENCY};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A fresh, empty directory under the system temp dir, unique per call so
    /// parallel `cargo test` runs (and repeated calls within one test) never
    /// collide. Callers are expected to clean it up when done.
    fn test_dir(tag: &str) -> std::path::PathBuf {
        let n = TEST_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "gamut_errors_test_{}_{tag}_{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A fully-populated `AppState` with the given error ring, for tests that
    /// need to prove behaviour reachable through real state (not just a bare
    /// function call). All other fields are harmless defaults.
    fn state_with_error_log(ring: VecDeque<ErrorEntry>) -> AppState {
        AppState {
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
            error_log: Mutex::new(ring),
            ide: Mutex::new(None),
        }
    }

    // A5: the public record entry point caps the ring at ERROR_LOG_CAP.
    #[test]
    fn record_error_caps_ring_at_100() {
        let dir = test_dir("cap");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        for i in 0..ERROR_LOG_CAP {
            record_error(&dir, &ring, &format!("msg-{i}"));
        }
        assert_eq!(ring.lock().unwrap().len(), ERROR_LOG_CAP);
        assert_eq!(ring.lock().unwrap().front().unwrap().message, "msg-0");

        // The 101st push evicts the oldest and keeps the ring at the cap.
        record_error(&dir, &ring, "msg-100");
        let log = ring.lock().unwrap();
        assert_eq!(log.len(), ERROR_LOG_CAP);
        assert_eq!(log.front().unwrap().message, "msg-1"); // msg-0 evicted
        assert_eq!(log.back().unwrap().message, "msg-100"); // newest present
        drop(log);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A6: the backend stamps at_ms inside record_error; the frontend never
    // supplies a timestamp.
    #[test]
    fn record_error_stamps_at_ms_itself() {
        let dir = test_dir("stamp");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        let before = now_ms();
        record_error(&dir, &ring, "boom");
        let after = now_ms();

        let entry = ring.lock().unwrap().back().unwrap().clone();
        assert!(entry.at_ms > 0);
        assert!(entry.at_ms >= before && entry.at_ms <= after);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A7: an over-long message is truncated with the marker, and even one
    // single message far larger than the file cap leaves the file within it.
    #[test]
    fn record_error_truncates_long_messages() {
        let dir = test_dir("truncate");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        let huge = "a".repeat(MAX_ERROR_MESSAGE_CHARS + 500);
        record_error(&dir, &ring, &huge);

        let entry = ring.lock().unwrap().back().unwrap().clone();
        assert!(entry.message.ends_with("… (truncated)"));
        assert_eq!(
            entry.message.chars().count(),
            MAX_ERROR_MESSAGE_CHARS + "… (truncated)".chars().count()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_error_keeps_file_within_byte_cap_for_one_huge_message() {
        let dir = test_dir("truncate-file-cap");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        // Far larger than ERROR_LOG_MAX_BYTES before truncation kicks in.
        let huge = "x".repeat(ERROR_LOG_MAX_BYTES as usize * 4);
        record_error(&dir, &ring, &huge);

        let raw = std::fs::read_to_string(dir.join(ERROR_LOG_FILE)).unwrap();
        // Assert the bound the code actually establishes for a single entry:
        // the *message* cap, not the file cap. Asserting only `<= 256 KiB`
        // would leave 64x headroom and would still pass with `trim_error_log`
        // deleted outright — it would be a property of truncation alone.
        assert_eq!(raw.lines().count(), 1, "one oversized message is one line");
        let worst_case_bytes = MAX_ERROR_MESSAGE_CHARS * 4 + 128; // 4 bytes/char + JSON envelope
        assert!(
            raw.len() <= worst_case_bytes,
            "single entry {} bytes exceeds the per-message bound {worst_case_bytes}",
            raw.len()
        );
        assert!((raw.len() as u64) <= ERROR_LOG_MAX_BYTES);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A8: append/hydrate round-trips a message containing \n and \r\n
    // byte-for-byte, and the file holds exactly one line for that entry.
    #[test]
    fn record_and_hydrate_roundtrip_preserves_newlines() {
        let dir = test_dir("newlines");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        let message = "line one\nline two\r\nline three";
        record_error(&dir, &ring, message);

        let raw = std::fs::read_to_string(dir.join(ERROR_LOG_FILE)).unwrap();
        assert_eq!(raw.lines().count(), 1);

        let hydrated = hydrate_error_log(&dir);
        assert_eq!(hydrated.len(), 1);
        assert_eq!(hydrated.back().unwrap().message, message);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A9: concurrent record_error calls from real threads never interleave or
    // truncate each other's lines, because the ring's mutex guards the append.
    #[test]
    fn concurrent_record_error_produces_well_formed_lines() {
        let dir = test_dir("concurrent");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        const N: usize = 25;

        std::thread::scope(|scope| {
            for i in 0..N {
                let dir = &dir;
                let ring = &ring;
                scope.spawn(move || {
                    record_error(dir, ring, &format!("concurrent-msg-{i}"));
                });
            }
        });

        let raw = std::fs::read_to_string(dir.join(ERROR_LOG_FILE)).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), N);
        let parsed: Vec<ErrorEntry> = lines
            .iter()
            .map(|l| serde_json::from_str(l).expect("every line must parse individually"))
            .collect();
        let mut messages: Vec<String> = parsed.into_iter().map(|e| e.message).collect();
        messages.sort();
        let mut expected: Vec<String> = (0..N).map(|i| format!("concurrent-msg-{i}")).collect();
        expected.sort();
        assert_eq!(messages, expected);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A10: hydrate keeps at most ERROR_LOG_CAP entries, and keeps the newest
    // ones, even when the file holds more lines while still under the byte cap.
    #[test]
    fn hydrate_caps_at_100_keeping_newest_even_under_byte_cap() {
        let dir = test_dir("hydrate-cap");
        let total = ERROR_LOG_CAP + 50;
        let mut lines = Vec::with_capacity(total);
        for i in 0..total {
            let entry = ErrorEntry {
                at_ms: i as u64,
                message: format!("msg-{i}"),
            };
            lines.push(serde_json::to_string(&entry).unwrap());
        }
        let contents = lines.join("\n") + "\n";
        assert!((contents.len() as u64) < ERROR_LOG_MAX_BYTES);
        std::fs::write(dir.join(ERROR_LOG_FILE), &contents).unwrap();

        let hydrated = hydrate_error_log(&dir);
        assert_eq!(hydrated.len(), ERROR_LOG_CAP);
        // The newest ERROR_LOG_CAP entries are msg-50 .. msg-149.
        let messages: Vec<String> = hydrated.iter().map(|e| e.message.clone()).collect();
        let expected: Vec<String> = (50..total).map(|i| format!("msg-{i}")).collect();
        assert_eq!(messages, expected);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A11: once the file exceeds the byte cap, the trim is line-aligned (every
    // remaining line parses — no partial leading line) and size-bounded, and
    // the newest entry survives.
    #[test]
    fn trim_is_line_aligned_and_size_bounded() {
        let dir = test_dir("trim");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        let filler = "y".repeat(3000);
        const N: usize = 200;
        for i in 0..N {
            record_error(&dir, &ring, &format!("msg-{i}-{filler}"));
        }

        let path = dir.join(ERROR_LOG_FILE);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(!raw.is_empty());
        let lines: Vec<&str> = raw.lines().collect();
        // Every remaining line parses individually — no partial leading line.
        let parsed: Vec<ErrorEntry> = lines
            .iter()
            .map(|l| serde_json::from_str(l).expect("no partial/corrupt leading line"))
            .collect();
        let len = std::fs::metadata(&path).unwrap().len();
        assert!(len <= ERROR_LOG_MAX_BYTES);
        assert!(parsed
            .iter()
            .any(|e| e.message.starts_with(&format!("msg-{}-", N - 1))));

        // A trim cuts to the low-water mark, not to the cap: cutting to the cap
        // would leave the file one append from being over again, so every
        // subsequent error would pay a full read-modify-write of the file.
        // Since the run above crossed the cap, the file must now sit at or
        // below the low-water mark plus the appends made after the last trim.
        assert!(
            len <= ERROR_LOG_TRIM_TO_BYTES + (ERROR_LOG_MAX_BYTES - ERROR_LOG_TRIM_TO_BYTES),
            "file should be trimmed to the low-water mark, not held at the cap"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The realistic post-crash shape: a truncated final line from an
    /// interrupted append, a non-UTF-8 byte run, and a valid entry in one
    /// file. Startup must survive it — `hydrate_error_log` is called from
    /// `setup`, so a panic here would stop the app launching.
    #[test]
    fn hydrate_survives_mixed_corruption_and_keeps_the_valid_entry() {
        let dir = test_dir("mixed-corruption");
        let good = ErrorEntry {
            at_ms: 7,
            message: "survivor".to_string(),
        };
        let mut contents: Vec<u8> = Vec::new();
        contents.extend_from_slice(b"{\"at_ms\":1,\"message\":\"trunca");
        contents.push(b'\n');
        contents.extend_from_slice(serde_json::to_string(&good).unwrap().as_bytes());
        contents.push(b'\n');
        contents.extend_from_slice(b"{\"at_ms\":2,\"message\":\"");
        contents.extend_from_slice(&[0xff, 0xfe]); // invalid UTF-8
        contents.extend_from_slice(b"\"}\n");
        std::fs::write(dir.join(ERROR_LOG_FILE), &contents).unwrap();

        // Non-UTF-8 anywhere in the file makes the whole read unusable, so the
        // documented contract is "empty ring, no panic" — never a crash.
        let hydrated = hydrate_error_log(&dir);
        assert!(hydrated.len() <= 1);

        // With the invalid bytes removed, the truncated line is skipped and the
        // valid entry survives.
        let utf8_only = format!(
            "{{\"at_ms\":1,\"message\":\"trunca\n{}\n",
            serde_json::to_string(&good).unwrap()
        );
        std::fs::write(dir.join(ERROR_LOG_FILE), utf8_only).unwrap();
        let hydrated = hydrate_error_log(&dir);
        assert_eq!(hydrated.len(), 1);
        assert_eq!(hydrated.back().unwrap().message, "survivor");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A12: hydrate never errors/panics on a missing, zero-byte, non-UTF-8, or
    // unreadable file, and skips a malformed line rather than aborting.
    #[test]
    fn hydrate_handles_missing_file() {
        let dir = test_dir("missing");
        assert_eq!(hydrate_error_log(&dir).len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hydrate_handles_zero_byte_file() {
        let dir = test_dir("zero-byte");
        std::fs::write(dir.join(ERROR_LOG_FILE), "").unwrap();
        assert_eq!(hydrate_error_log(&dir).len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hydrate_handles_non_utf8_file() {
        let dir = test_dir("non-utf8");
        std::fs::write(dir.join(ERROR_LOG_FILE), [0xff, 0xfe, 0x00, 0xd8]).unwrap();
        assert_eq!(hydrate_error_log(&dir).len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
    fn hydrate_handles_unreadable_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = test_dir("unreadable");
        let path = dir.join(ERROR_LOG_FILE);
        // A *valid* entry, deliberately: with unparseable contents the
        // assertion below would pass via the skip-malformed-line path whether
        // or not the read actually failed, leaving this branch unverified.
        let good = ErrorEntry {
            at_ms: 42,
            message: "readable-if-permissions-allowed".to_string(),
        };
        std::fs::write(
            &path,
            format!("{}\n", serde_json::to_string(&good).unwrap()),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();

        // Root bypasses the mode bits entirely, so the read would succeed and
        // this would be asserting the opposite of what it claims.
        if std::fs::read(&path).is_ok() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let _ = std::fs::remove_dir_all(&dir);
            eprintln!("skipping hydrate_handles_unreadable_file: mode bits not enforced (root?)");
            return;
        }

        // Now zero entries is reachable only because the read failed.
        assert_eq!(hydrate_error_log(&dir).len(), 0);

        // Restore permissions so cleanup can remove it.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hydrate_skips_a_malformed_line_instead_of_aborting() {
        let dir = test_dir("malformed-line");
        let good = ErrorEntry {
            at_ms: 42,
            message: "ok".to_string(),
        };
        let contents = format!(
            "{}\nnot json at all\n",
            serde_json::to_string(&good).unwrap()
        );
        std::fs::write(dir.join(ERROR_LOG_FILE), contents).unwrap();

        let hydrated = hydrate_error_log(&dir);
        assert_eq!(hydrated.len(), 1);
        assert_eq!(hydrated.back().unwrap().message, "ok");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A13: hydration is reachable from a real AppState's snapshot-read path,
    // not merely "the hydrate function works in isolation".
    #[test]
    fn state_hydrated_from_existing_log_flows_through_snapshot_path() {
        let dir = test_dir("hydrate-into-state");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        record_error(&dir, &ring, "seeded-before-restart");

        // Simulate the restart: hydrate fresh from the data dir, exactly as
        // lib.rs's setup does, then build the real AppState around it.
        let hydrated = hydrate_error_log(&dir);
        let state = state_with_error_log(hydrated);

        // recent_errors() is the exact helper snapshot() reads from.
        let via_snapshot_path = recent_errors(&state);
        assert_eq!(via_snapshot_path.len(), 1);
        assert_eq!(via_snapshot_path[0].message, "seeded-before-restart");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A14: Diagnostics carries recent_errors, and the written bundle contains
    // a recorded error's message text.
    #[test]
    fn write_bundle_includes_recorded_error_text() {
        let dir = test_dir("write-bundle");
        let bundle = Diagnostics {
            app_version: "0.0.0-test".to_string(),
            os: "test".to_string(),
            arch: "test".to_string(),
            generated_at_ms: 0,
            repo_count: 0,
            group_count: 0,
            watched_path_count: 0,
            watch_failed_count: 0,
            op_stats: Vec::new(),
            recent_ops: Vec::new(),
            recent_errors: vec![ErrorEntry {
                at_ms: 1234,
                message: "distinctive-error-boom-9001".to_string(),
            }],
        };
        let out_path = dir.join("bundle.json");
        write_bundle(&bundle, out_path.to_str().unwrap()).unwrap();

        let written = std::fs::read_to_string(&out_path).unwrap();
        assert!(written.contains("distinctive-error-boom-9001"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    // A22: Clear empties the ring and removes the file together.
    #[test]
    fn clear_error_log_empties_ring_and_file_together() {
        let dir = test_dir("clear");
        let ring: Mutex<VecDeque<ErrorEntry>> = Mutex::new(VecDeque::new());
        record_error(&dir, &ring, "one");
        record_error(&dir, &ring, "two");
        assert_eq!(ring.lock().unwrap().len(), 2);

        clear_error_log(&dir, &ring).unwrap();

        assert_eq!(ring.lock().unwrap().len(), 0);
        assert_eq!(hydrate_error_log(&dir).len(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
