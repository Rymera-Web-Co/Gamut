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
//! Output streams to the frontend over a Tauri [`Channel`] of raw bytes; xterm's
//! decoder reassembles UTF-8 across chunk boundaries, so we never split on a
//! character. Shell exit is signalled out-of-band via a `terminal-exit` event.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::MutexGuard;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
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

/// A usable working directory for a new shell: the requested `cwd` if it still
/// exists, else the user's home directory, else the filesystem root. A restored
/// terminal layout (#155) can reference a repo path that has since moved or been
/// deleted; falling back keeps the respawned shell usable instead of failing the
/// spawn outright.
fn resolve_cwd(cwd: &str) -> String {
    if std::path::Path::new(cwd).is_dir() {
        return cwd.to_string();
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
    on_output: Channel<Vec<u8>>,
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

    // PTY reads block, so they live on a dedicated OS thread (not the tokio pool).
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_output.send(buf[..n].to_vec()).is_err() {
                        break; // frontend dropped the channel
                    }
                }
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
