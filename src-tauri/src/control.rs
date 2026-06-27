//! Local control channel for steering the running app's window from an external
//! local process.
//!
//! The running app binds a loopback `TcpListener` and writes the chosen port to
//! `<app-data>/control.port` and a random handshake token to
//! `<app-data>/control.token`. It *also* publishes a per-instance file
//! `<app-data>/control.d/<pid>.json` (port + token + whether this is a dev
//! build), so that several apps sharing one app-data dir — e.g. a `tauri dev`
//! build running alongside an installed release — don't clobber each other's
//! endpoint. The shared `control.port`/`control.token` files remain for older
//! clients; newer clients prefer the per-instance registry and can target a
//! specific app. A client reads both, connects, and sends one line
//! of JSON describing a UI-navigation command; the app validates the token,
//! re-emits the command to the webview as a `ui-nav` event, and the frontend
//! routes it through the existing one-shot deep-link store hooks
//! (`setActiveRepo` / `setView` / `setFilesPath` / `setHistorySha`).
//!
//! Loopback TCP (rather than a unix socket) keeps a single code path across
//! macOS / Linux / Windows. The token isn't a hard security boundary against
//! the same user — it gates *other* local users who can't read the token file,
//! which on unix is created `0600`.

use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// File under the app-data dir holding the active control-channel TCP port. A
/// client reads this to connect (it recomputes this dir itself).
const PORT_FILE: &str = "control.port";
/// File under the app-data dir holding the handshake token.
const TOKEN_FILE: &str = "control.token";
/// Subdirectory under the app-data dir holding one `<pid>.json` per running
/// instance, so concurrently-running apps don't clobber each other's endpoint.
const INSTANCE_DIR: &str = "control.d";
/// Event the frontend listens for to apply a UI-navigation command.
const UI_NAV_EVENT: &str = "ui-nav";

/// A UI-navigation command. Re-emitted verbatim to the webview as the `ui-nav`
/// event payload; field names are snake_case to match the frontend's existing
/// IPC types. `action` is one of `select-repo` | `view` | `open` | `goto` |
/// `term` | `term-close`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UiNav {
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    // `term` only: the working directory and tab title for the new terminal,
    // the command to type into it, and whether to press Enter (run) vs. leave it
    // staged at the prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse: Option<bool>,
    // `term` only: open the terminal in the background — create it (and start its
    // shell so any queued command still runs) without switching the active
    // group/repo/view or revealing the terminal panel. Absent = focus as usual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub silent: Option<bool>,
}

/// One line of request a client writes to the socket: the handshake token plus
/// the navigation command (flattened so the wire form is a single flat object).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlRequest {
    pub token: String,
    #[serde(flatten)]
    pub nav: UiNav,
}

/// The app's single-line reply. `data` carries a payload for query actions
/// (currently `term-list`); it's absent for the fire-and-forget nav commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponse {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// What we publish to `control.d/<pid>.json` so a client can discover this
/// running app and target it specifically. Holds the same port + token as the
/// shared files, plus identifying bits (`dev` distinguishes a `tauri dev` build
/// from a release; `label` is a friendly name for listings).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    /// True for a debug / `tauri dev` build, false for a release build.
    pub dev: bool,
    pub label: String,
}

/// Start the control channel: bind a loopback port, publish the port + token
/// files, and serve connections on a background thread. Best-effort — any
/// failure is logged and leaves the app otherwise fully functional.
pub fn start(app: AppHandle) {
    let Ok(data_dir) = app.path().app_data_dir() else {
        eprintln!("control channel: could not resolve app-data dir");
        return;
    };
    let _ = std::fs::create_dir_all(&data_dir);

    let listener = match TcpListener::bind(("127.0.0.1", 0)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("control channel: bind failed: {e}");
            return;
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("control channel: local_addr failed: {e}");
            return;
        }
    };

    let token = generate_token();
    // Write the token (restricted perms) before the port file, so a client
    // that sees a port always finds a token too.
    if let Err(e) = write_private(&data_dir.join(TOKEN_FILE), token.as_bytes()) {
        eprintln!("control channel: writing token failed: {e}");
        return;
    }
    if let Err(e) = std::fs::write(data_dir.join(PORT_FILE), port.to_string()) {
        eprintln!("control channel: writing port failed: {e}");
        return;
    }

    // Publish a per-instance file too, so a client can tell concurrently-running
    // apps apart and target one. Best-effort: failure here only costs the
    // multi-app selector, not the shared-file path above.
    let dev = cfg!(debug_assertions);
    let info = InstanceInfo {
        port,
        token: token.clone(),
        pid: std::process::id(),
        dev,
        label: format!("Gamut{}", if dev { " (dev)" } else { "" }),
    };
    let inst_dir = data_dir.join(INSTANCE_DIR);
    if let Err(e) = std::fs::create_dir_all(&inst_dir) {
        eprintln!("control channel: creating instance dir failed: {e}");
    } else if let Ok(body) = serde_json::to_string(&info) {
        // The token lives in here, so lock it down like the token file.
        if let Err(e) = write_private(
            &inst_dir.join(format!("{}.json", info.pid)),
            body.as_bytes(),
        ) {
            eprintln!("control channel: writing instance file failed: {e}");
        }
    }

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(s) => handle_conn(&app, &token, s),
                Err(_) => continue,
            }
        }
    });
}

/// Remove the shared port file and this instance's registry entry so a later
/// client reports "app not running" instead of dialing a dead port. Called when
/// the window closes.
///
/// The shared port file is removed unconditionally, preserving the original
/// single-app behavior. (With several apps running it's whatever the
/// last-booted one wrote, so removing it can briefly hide a still-running app
/// from clients that only read the shared files — newer clients use the
/// per-instance registry and aren't affected.) The registry entry is keyed by
/// pid, so we only ever drop our own; other instances' entries are untouched.
pub fn cleanup(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::remove_file(dir.join(PORT_FILE));
        let _ = std::fs::remove_file(
            dir.join(INSTANCE_DIR)
                .join(format!("{}.json", std::process::id())),
        );
    }
}

/// Read one request line, validate the token, and re-emit the command as the
/// `ui-nav` event. Replies with a single JSON line.
fn handle_conn(app: &AppHandle, token: &str, stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }

    let resp = match serde_json::from_str::<ControlRequest>(line.trim()) {
        Ok(req) if req.token == token => {
            // `term-list` is a *query*: answer it from the mirrored terminal
            // registry rather than emitting a UI-navigation event.
            if req.nav.action == "term-list" {
                read_terminals(app)
            } else {
                match app.emit(UI_NAV_EVENT, &req.nav) {
                    Ok(()) => ControlResponse {
                        ok: true,
                        error: None,
                        data: None,
                    },
                    Err(e) => ControlResponse {
                        ok: false,
                        error: Some(format!("emit failed: {e}")),
                        data: None,
                    },
                }
            }
        }
        Ok(_) => ControlResponse {
            ok: false,
            error: Some("unauthorized".into()),
            data: None,
        },
        Err(e) => ControlResponse {
            ok: false,
            error: Some(format!("bad request: {e}")),
            data: None,
        },
    };

    if let Ok(body) = serde_json::to_string(&resp) {
        let mut stream = reader.into_inner();
        let _ = writeln!(stream, "{body}");
        let _ = stream.flush();
    }
}

/// Build the `term-list` reply from the mirrored terminal registry. Best-effort:
/// a missing state or poisoned lock yields an empty list rather than an error.
fn read_terminals(app: &AppHandle) -> ControlResponse {
    let data = app
        .try_state::<AppState>()
        .and_then(|s| {
            s.terminal_registry
                .lock()
                .ok()
                .map(|r| serde_json::to_value(&*r))
        })
        .transpose()
        .ok()
        .flatten()
        .unwrap_or_else(|| serde_json::Value::Array(vec![]));
    ControlResponse {
        ok: true,
        error: None,
        data: Some(data),
    }
}

/// A short opaque handshake token. Not cryptographic — the token file's
/// permissions are the real gate; this just keeps unrelated local processes
/// from accidentally driving the window. Avoids pulling in an RNG crate by
/// hashing high-resolution time, the pid, and a stack address.
fn generate_token() -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    let stack_marker = 0u8;
    (&stack_marker as *const u8 as usize).hash(&mut hasher);
    let a = hasher.finish();
    // Mix a second round so the value isn't a single 64-bit hash.
    a.wrapping_mul(0x9E37_79B9_7F4A_7C15).hash(&mut hasher);
    format!("{:016x}{:016x}", a, hasher.finish())
}

/// Write `contents` to `path`, restricting it to the owner on unix (`0600`).
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_request_roundtrips_flat() {
        let req = ControlRequest {
            token: "abc".into(),
            nav: UiNav {
                action: "open".into(),
                repo_id: Some(7),
                path: Some("src/App.tsx".into()),
                ..UiNav::default()
            },
        };
        let wire = serde_json::to_string(&req).unwrap();
        // `nav` is flattened: token + action sit on the same object.
        assert!(wire.contains("\"token\":\"abc\""));
        assert!(wire.contains("\"action\":\"open\""));
        assert!(!wire.contains("\"view\""), "None fields are omitted");

        let back: ControlRequest = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.token, "abc");
        assert_eq!(back.nav.action, "open");
        assert_eq!(back.nav.repo_id, Some(7));
        assert_eq!(back.nav.path.as_deref(), Some("src/App.tsx"));
    }

    #[test]
    fn instance_info_roundtrips() {
        let info = InstanceInfo {
            port: 49321,
            token: "deadbeef".into(),
            pid: 4321,
            dev: true,
            label: "Gamut (dev)".into(),
        };
        let wire = serde_json::to_string(&info).unwrap();
        let back: InstanceInfo = serde_json::from_str(&wire).unwrap();
        assert_eq!(back.port, 49321);
        assert_eq!(back.token, "deadbeef");
        assert_eq!(back.pid, 4321);
        assert!(back.dev);
        assert_eq!(back.label, "Gamut (dev)");
    }

    #[test]
    fn response_roundtrips() {
        let r = ControlResponse {
            ok: false,
            error: Some("unauthorized".into()),
            data: None,
        };
        let wire = serde_json::to_string(&r).unwrap();
        let back: ControlResponse = serde_json::from_str(&wire).unwrap();
        assert!(!back.ok);
        assert_eq!(back.error.as_deref(), Some("unauthorized"));
    }
}
