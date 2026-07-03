//! Per-scope integrated terminal backed by a real PTY (`portable-pty`).
//!
//! A "session" is one interactive shell rooted at a working directory, keyed by
//! an opaque string the frontend chooses — `repo:<id>` for a repository's
//! terminal, `group:<id>` for a folder-bound group's terminal. Sessions live in
//! [`AppState::terminals`] independently of which one is visible, so a build or
//! `tail -f` keeps running while its tab is hidden. Switching tabs only toggles
//! visibility on the frontend; the PTY is never torn down until it's explicitly
//! killed (tab closed, repo removed, app closed) or its shell exits.
//!
//! Output streams to the frontend over a Tauri [`Channel`] of raw bytes (via
//! [`tauri::ipc::Response`], so it crosses IPC as an `ArrayBuffer` instead of a
//! JSON number array); xterm's decoder reassembles UTF-8 across chunk
//! boundaries, so we never split on a character. Reads are coalesced over a
//! short window (see [`COALESCE_WINDOW`]) before being emitted, so heavy
//! output (builds, `tail -f`, progress bars) doesn't ship one IPC message per
//! 8 KB PTY read. Shell exit is signalled out-of-band via a `terminal-exit`
//! event.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc;
use std::sync::MutexGuard;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::settings;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Event emitted (payload: the session id) when a shell exits or its PTY closes,
/// so the frontend can mark the tab dead and stop forwarding keystrokes.
pub const TERMINAL_EXIT: &str = "terminal-exit";

/// A live PTY-backed shell. Owns the master side (for resize), the writer (for
/// keystrokes) and the child handle (to terminate). The read side is owned by a
/// dedicated reader thread spawned at creation.
pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

type Sessions<'a> = MutexGuard<'a, HashMap<String, Session>>;

fn lock(state: &AppState) -> AppResult<Sessions<'_>> {
    state
        .terminals
        .lock()
        .map_err(|e| AppError::Other(format!("terminal lock poisoned: {e}")))
}

fn pty_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Other(format!("pty error: {e}"))
}

/// The interactive shell to launch: the user's login shell on unix, the command
/// processor on Windows. Falls back to a sane default if the env var is unset.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

/// POSIX shells we know accept `-l` to run as a login shell (and that are
/// interactive when attached to a PTY). The login flag is only appended for
/// these recognised basenames so an arbitrary `pref.terminalShell` override —
/// which can be any command, not necessarily a shell — isn't broken by an
/// argument it doesn't understand.
#[cfg(not(windows))]
const LOGIN_SHELLS: &[&str] = &["bash", "zsh", "sh", "fish", "dash", "ksh"];

/// Append the login-shell flag so the shell sources the user's init files
/// (`~/.zprofile`/`~/.zshrc`, `~/.bash_profile`, …). macOS terminal emulators
/// (Terminal.app, iTerm2, VS Code) all launch `$SHELL` as a login shell; without
/// it the in-app terminal misses PATH additions, aliases and version-manager
/// shims, and GUI-launched apps start with a minimal environment to begin with.
/// No-op for an unrecognised command, and absent entirely on Windows where
/// `cmd.exe`/`COMSPEC` has no login-shell concept.
#[cfg(not(windows))]
fn apply_login_shell(cmd: &mut CommandBuilder, shell: &str) {
    let base = std::path::Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(shell);
    if LOGIN_SHELLS.contains(&base) {
        cmd.arg("-l");
    }
}

#[cfg(windows)]
fn apply_login_shell(_cmd: &mut CommandBuilder, _shell: &str) {}

/// Strip the Windows verbatim / extended-length prefix (`\\?\`) that
/// `Path::canonicalize` adds to every path. Repo paths are stored canonicalized
/// (see `commands::repo::register_path`), so they carry it. An interactive
/// `cmd.exe` rejects a `\\?\C:\…` working directory — it prints "UNC paths are
/// not supported. Defaulting to Windows directory." and opens in `C:\Windows`
/// instead of the repo — so the path has to be simplified before it's handed to
/// the shell as its cwd. No-op on non-Windows and for paths without the prefix.
fn strip_verbatim_prefix(path: &str) -> String {
    #[cfg(windows)]
    {
        // `\\?\UNC\server\share` -> `\\server\share`
        if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        // `\\?\C:\...` -> `C:\...`, but only for a real drive path (`X:`); a
        // `\\?\Volume{GUID}\...` path has no drive-letter form, so leave it.
        if let Some(rest) = path.strip_prefix(r"\\?\") {
            let b = rest.as_bytes();
            if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                return rest.to_string();
            }
        }
    }
    path.to_string()
}

/// A usable working directory for a new shell: the requested `cwd` if it still
/// exists, else the user's home directory, else the filesystem root. A restored
/// terminal layout (#155) can reference a repo path that has since moved or been
/// deleted; falling back keeps the respawned shell usable instead of failing the
/// spawn outright.
fn resolve_cwd(cwd: &str) -> String {
    let cwd = strip_verbatim_prefix(cwd);
    if std::path::Path::new(&cwd).is_dir() {
        return cwd;
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        if std::path::Path::new(&home).is_dir() {
            return home.to_string_lossy().into_owned();
        }
    }
    if cfg!(windows) {
        "C:\\".to_string()
    } else {
        "/".to_string()
    }
}

/// How long to accumulate PTY reads before emitting them as one IPC message.
/// Bursty output (a build, `tail -f`, a progress bar) arrives across many 8 KB
/// reads within a few milliseconds of each other; batching them cuts the
/// per-chunk IPC/JS overhead roughly in proportion to burst size while staying
/// well under human perception for interactive typing echo.
const COALESCE_WINDOW: Duration = Duration::from_millis(8);

/// Cap on bytes buffered before a forced flush, so a sustained firehose (e.g.
/// `yes` or a huge log dump) can't grow the pending buffer unbounded while
/// waiting out the coalescing window. Soft cap: a batch can overshoot it by
/// up to one PTY read (currently 8 KiB), since we only check after a full
/// chunk has been appended, not mid-chunk.
const COALESCE_MAX_BYTES: usize = 256 * 1024;

/// Blocks for the next chunk, then greedily drains whatever else arrives
/// within `COALESCE_WINDOW` of it (or until `COALESCE_MAX_BYTES` is hit),
/// returning the concatenation as one batch. Returns `None` once the sender
/// is dropped and no chunk is pending, signalling the PTY reader has exited.
fn next_coalesced_batch(rx: &mpsc::Receiver<Vec<u8>>) -> Option<Vec<u8>> {
    let mut pending = rx.recv().ok()?;
    let deadline = Instant::now() + COALESCE_WINDOW;
    loop {
        if pending.len() >= COALESCE_MAX_BYTES {
            break;
        }
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(more) => pending.extend_from_slice(&more),
            Err(_) => break, // timed out or sender gone; flush what we have
        }
    }
    Some(pending)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Spawn a shell for `session_id` rooted at `cwd`, streaming its output to
/// `on_output`. Idempotent: if a session with this id already exists it is left
/// untouched (the frontend keeps its xterm + channel alive across hide/show, so
/// it only spawns once per session). Errors if `cwd` isn't a usable directory or
/// the PTY can't be allocated.
#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<AppState>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    on_output: Channel<Response>,
) -> AppResult<()> {
    if lock(&state)?.contains_key(&session_id) {
        return Ok(()); // already running — reuse the existing session
    }

    let pair = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(pty_err)?;

    // A configured shell override wins; otherwise use the login shell. Blank or
    // unset falls back to the platform default.
    let shell = settings::get(&state, "pref.terminalShell")
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(default_shell);
    let mut cmd = CommandBuilder::new(&shell);
    // Run as a login shell so the user's init files are sourced, matching
    // Terminal.app / iTerm2 / VS Code behaviour (see `apply_login_shell`).
    apply_login_shell(&mut cmd, &shell);
    // Fall back to home/root if the requested directory is gone (#155).
    cmd.cwd(resolve_cwd(&cwd));
    // Advertise a capable terminal so prompts, colors and full-screen apps work.
    cmd.env("TERM", "xterm-256color");
    let child = pair.slave.spawn_command(cmd).map_err(pty_err)?;

    let mut reader = pair.master.try_clone_reader().map_err(pty_err)?;
    let writer = pair.master.take_writer().map_err(pty_err)?;
    // Drop the slave once the child holds it, so the master read returns EOF when
    // the shell exits (otherwise our lingering handle keeps the pipe open).
    drop(pair.slave);

    lock(&state)?.insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            child,
        },
    );

    // PTY reads block, so they live on a dedicated OS thread (not the tokio
    // pool). It hands raw chunks off to a forwarder thread over an mpsc
    // channel rather than emitting directly, so it can keep reading (and thus
    // keep coalescing) without waiting on IPC.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // forwarder thread gone
                    }
                }
            }
        }
        // Dropping `tx` here closes the channel, which unblocks the forwarder
        // thread's `recv()` so it can run teardown below.
    });

    // Forwarder: coalesces chunks arriving within `COALESCE_WINDOW` of the
    // first one in a batch into a single IPC message, rather than emitting
    // per 8 KB PTY read.
    std::thread::spawn(move || {
        while let Some(batch) = next_coalesced_batch(&rx) {
            if on_output.send(Response::new(batch)).is_err() {
                break; // frontend dropped the channel
            }
        }
        if let Some(state) = app.try_state::<AppState>() {
            if let Ok(mut sessions) = state.terminals.lock() {
                sessions.remove(&session_id);
            }
        }
        let _ = app.emit(TERMINAL_EXIT, &session_id);
    });

    Ok(())
}

/// One open terminal tab, as the frontend mirrors it for the control channel's
/// `term-list` query (see [`terminal_registry_report`]). The PTY registry itself
/// (`AppState::terminals`) is keyed by opaque pane id and holds no names/cwd, so
/// the human-meaningful layout has to come from the webview, which owns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInfo {
    /// The group the tab lives under (terminals are per-group).
    pub group_id: i64,
    pub tab_id: String,
    /// The tab's display label (custom name if set, else the default).
    pub name: String,
    /// Number of side-by-side panes in the tab.
    pub panes: usize,
    /// Working directory of the tab's first pane (lets a client map it to a repo).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Replace the mirrored terminal layout. The frontend calls this on every
/// terminal-layout change so the control channel can answer `term-list` from
/// fresh in-memory state without round-tripping to the webview.
#[tauri::command]
pub fn terminal_registry_report(
    state: State<AppState>,
    terminals: Vec<TerminalInfo>,
) -> AppResult<()> {
    *state
        .terminal_registry
        .lock()
        .map_err(|e| AppError::Other(format!("terminal registry lock poisoned: {e}")))? = terminals;
    Ok(())
}

/// Forward keystrokes (raw bytes) to a session's shell. No-op if the session is gone.
#[tauri::command]
pub fn terminal_write(state: State<AppState>, session_id: String, data: Vec<u8>) -> AppResult<()> {
    let mut sessions = lock(&state)?;
    if let Some(s) = sessions.get_mut(&session_id) {
        s.writer.write_all(&data).map_err(pty_err)?;
        let _ = s.writer.flush();
    }
    Ok(())
}

/// Propagate a terminal resize to the PTY so full-screen apps reflow. No-op if gone.
#[tauri::command]
pub fn terminal_resize(
    state: State<AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    let sessions = lock(&state)?;
    if let Some(s) = sessions.get(&session_id) {
        s.master.resize(size(cols, rows)).map_err(pty_err)?;
    }
    Ok(())
}

/// Terminate a session's shell and drop it.
#[tauri::command]
pub fn terminal_kill(state: State<AppState>, session_id: String) -> AppResult<()> {
    kill(&state, &session_id);
    Ok(())
}

/// Kill a single session by id, if present. Safe to call for unknown ids.
pub fn kill(state: &AppState, session_id: &str) {
    if let Ok(mut sessions) = state.terminals.lock() {
        if let Some(mut s) = sessions.remove(session_id) {
            let _ = s.child.kill();
        }
    }
}

/// Kill every live session. Used on app/window close.
pub fn kill_all(state: &AppState) {
    if let Ok(mut sessions) = state.terminals.lock() {
        for (_, mut s) in sessions.drain() {
            let _ = s.child.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A burst of chunks sent back-to-back (well within `COALESCE_WINDOW`)
    /// should come back as a single batch, not one per chunk.
    #[test]
    fn coalesces_a_fast_burst() {
        let (tx, rx) = mpsc::channel();
        for chunk in [b"hello ".to_vec(), b"world".to_vec(), b"!".to_vec()] {
            tx.send(chunk).unwrap();
        }
        drop(tx);

        let batch = next_coalesced_batch(&rx).expect("first batch");
        assert_eq!(batch, b"hello world!");
        // Sender is gone and the channel is drained, so the next call sees a
        // closed channel with nothing pending.
        assert!(next_coalesced_batch(&rx).is_none());
    }

    /// A lone chunk with no follow-up must still flush once the coalescing
    /// window elapses, rather than waiting forever for more data that never
    /// arrives (e.g. a shell prompt printed once, then idle for input).
    #[test]
    fn flushes_a_lone_chunk_after_the_window() {
        let (tx, rx) = mpsc::channel();
        tx.send(b"prompt$ ".to_vec()).unwrap();

        let start = Instant::now();
        let batch = next_coalesced_batch(&rx).expect("batch");
        assert_eq!(batch, b"prompt$ ");
        // Flushed once the window elapsed, not held indefinitely.
        assert!(start.elapsed() >= COALESCE_WINDOW);
        assert!(start.elapsed() < COALESCE_WINDOW * 5);
    }

    /// Chunks that arrive spaced further apart than `COALESCE_WINDOW` must
    /// stay in separate batches — coalescing must not merge unrelated bursts
    /// into one giant delayed emission.
    #[test]
    fn keeps_slow_chunks_separate() {
        let (tx, rx) = mpsc::channel();
        tx.send(b"first".to_vec()).unwrap();
        let tx2 = tx.clone();
        std::thread::spawn(move || {
            std::thread::sleep(COALESCE_WINDOW * 3);
            tx2.send(b"second".to_vec()).unwrap();
        });

        let first = next_coalesced_batch(&rx).expect("first batch");
        assert_eq!(first, b"first");
        let second = next_coalesced_batch(&rx).expect("second batch");
        assert_eq!(second, b"second");
    }

    /// Once `COALESCE_MAX_BYTES` is reached the batch flushes immediately
    /// instead of waiting out the rest of the window, bounding memory/latency
    /// under a sustained firehose.
    #[test]
    fn flushes_early_once_max_bytes_reached() {
        let (tx, rx) = mpsc::channel();
        let big = vec![b'x'; COALESCE_MAX_BYTES];
        tx.send(big.clone()).unwrap();
        tx.send(b"tail".to_vec()).unwrap();
        drop(tx);

        let start = Instant::now();
        let batch = next_coalesced_batch(&rx).expect("batch");
        assert_eq!(batch.len(), COALESCE_MAX_BYTES);
        // Should not have waited out the full coalescing window to flush.
        assert!(start.elapsed() < COALESCE_WINDOW);

        // The chunk that arrived after the cap was hit stays in the next batch.
        let next = next_coalesced_batch(&rx).expect("next batch");
        assert_eq!(next, b"tail");
    }

    /// The Windows verbatim prefix that `canonicalize` adds is stripped so the
    /// shell gets a cwd `cmd.exe` accepts; plain paths pass through untouched.
    #[test]
    fn strips_windows_verbatim_prefix() {
        // Pass-through cases hold on every platform.
        assert_eq!(strip_verbatim_prefix("/home/user/repo"), "/home/user/repo");
        assert_eq!(strip_verbatim_prefix(r"C:\tools\Gamut"), r"C:\tools\Gamut");

        // The stripping itself only happens on Windows.
        #[cfg(windows)]
        {
            assert_eq!(
                strip_verbatim_prefix(r"\\?\C:\tools\Gamut"),
                r"C:\tools\Gamut"
            );
            assert_eq!(
                strip_verbatim_prefix(r"\\?\UNC\server\share\x"),
                r"\\server\share\x"
            );
            // A volume-GUID verbatim path has no drive-letter form; leave it.
            let vol = r"\\?\Volume{12345678-0000-0000-0000-000000000000}\x";
            assert_eq!(strip_verbatim_prefix(vol), vol);
        }
    }
}
