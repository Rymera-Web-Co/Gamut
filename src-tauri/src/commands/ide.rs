//! Tauri commands for Claude Code's IDE integration (`crate::claude_ide`): let
//! the frontend push the current editor selection to connected `claude`
//! clients, and report the server's status.

use serde::Serialize;
use tauri::State;

use crate::claude_ide::Selection;
use crate::error::AppResult;
use crate::state::AppState;

/// Status of the IDE WebSocket server, for diagnostics / a status indicator.
#[derive(Debug, Clone, Serialize)]
pub struct IdeStatus {
    /// Whether the server is running (bound + lockfile published).
    pub running: bool,
    /// The port terminals advertise via `CLAUDE_CODE_SSE_PORT`, if running.
    pub port: Option<u16>,
    /// Number of connected `claude` clients.
    pub connected: usize,
}

/// Report whether the IDE server is up, its port, and how many CLIs are attached.
#[tauri::command]
pub fn ide_status(state: State<AppState>) -> IdeStatus {
    match state.ide.lock().ok().and_then(|h| h.clone()) {
        Some(handle) => IdeStatus {
            running: true,
            port: Some(handle.port()),
            connected: handle.client_count(),
        },
        None => IdeStatus {
            running: false,
            port: None,
            connected: 0,
        },
    }
}

/// Push the current editor selection to every connected `claude` client, which
/// surfaces it as ambient context. A no-op when the server isn't running.
#[tauri::command]
pub fn ide_selection_changed(state: State<AppState>, selection: Selection) -> AppResult<()> {
    if let Some(handle) = state.ide.lock().ok().and_then(|h| h.clone()) {
        handle.push_selection(selection);
    }
    Ok(())
}
